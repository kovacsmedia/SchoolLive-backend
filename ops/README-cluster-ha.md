# SchoolLive backend — több-node üzemeltetési útmutató

Ez a fájl a Kör 2 terv **operatív** (nem alkalmazáskód) részét fedi le: E. fájlszinkron
és F. Postgres HA. Kódszinten (app-node, kliensek) minden más rész MÁR készen van —
ez itt a kézi/egyszeri beüzemelési lépéssor.

**Alapelv, amit minden lépés betart**: kész, bevált eszközök (rsync, `pg_auto_failover`,
PgBouncer), NULLA egyedi failover-/replikációs logika az alkalmazásban vagy a szkriptekben.

---

## A. Elnevezés (nincs teendő itt)

`api.schoollive.hu` marad az első node, az új VPS `api1.schoollive.hu`. A `NODE_HOSTNAME`
env változó az egyetlen helyen kódolja ezt (`.env`), a `ops/nodes.txt` és a GitHub Actions
`DEPLOY_HOSTS` repo Variable tartja karban a teljes listát.

## E. Fájlszinkron (hangfájlok) — beüzemelés

1. **Dedikált SSH kulcspár a mesh-hez** (NEM a CI `DEPLOY_KEY` — az csak a GitHub
   Actions futtatókon él, a szervereken nem):
   ```bash
   ssh-keygen -t ed25519 -f id_ed25519_mesh -N "" -C "schoollive-node-mesh"
   ```
2. **Ugyanazt a privát kulcsot** másold fel MINDEN node-ra, `/home/deploy/.ssh/id_ed25519_mesh`
   (0600 jogosultsággal), és a hozzá tartozó publikus kulcsot tedd be MINDEN node
   `/home/deploy/.ssh/authorized_keys` fájljába (minden node hitelesítse mindegyiket —
   ugyanaz a bizalmi kör, mint a meglévő CI deploy-nál, csak külön kulccsal, hogy a CI
   kulcs sose kelljen a szervereken tárolni).
3. `ops/nodes.txt` karbantartása — minden node hostname-je, egy sor/node (ez git-ben van,
   minden node-ra ugyanaz megy ki a rendes deploy-jal).
4. Systemd egységek telepítése minden node-on:
   ```bash
   sudo cp /opt/schoollive/backend/ops/rsync-mirror.service /etc/systemd/system/
   sudo cp /opt/schoollive/backend/ops/rsync-mirror.timer /etc/systemd/system/
   sudo systemctl daemon-reload
   sudo systemctl enable --now rsync-mirror.timer
   ```
5. **Ellenőrzés**: tölts fel egy hangfájlt az egyik node-on, néhány perc múlva nézd meg a
   másik node lemezén (`ls /opt/schoollive/backend/audio/...`), hogy megjelent-e.
   ```bash
   sudo systemctl status rsync-mirror.timer
   sudo journalctl -u rsync-mirror.service -n 50
   ```

## F. Postgres HA — `pg_auto_failover` beüzemelés

**Előfeltétel, amit vállaltál**: egy 3. gép, **kizárólag monitor-szerepre** (nem osztozhat
adat-node-dal — ha az a gép esik ki, a monitor is vele esik, pont akkor nincs automatikus
failover, amikor kéne). Kicsi gép is elég (1 vCPU / 1GB).

### F.1 Csomagtelepítés (mindhárom gépen)

Debian/Ubuntu — a hivatalos `pgautofailover` csomagforrás szerint (lásd a
[pg_auto_failover dokumentáció](https://pg-auto-failover.readthedocs.io/) telepítési
lépéseit a használt Postgres major verzióhoz és disztribúcióhoz igazítva):
```bash
sudo apt install postgresql-<verzió>-auto-failover pg-auto-failover-cli jq
```

### F.2 Monitor létrehozása (a 3. gépen)

```bash
sudo pg_autoctl create monitor \
  --pgdata /var/lib/postgresql/pgautofailover-monitor \
  --auth trust \
  --ssl-self-signed \
  --hostname <monitor-gép-publikus-vagy-privát-hostneve> \
  --run
```
Jegyezd fel a parancs kimenetében megjelenő monitor connection string-et
(`postgres://autoctl_node@<monitor-host>:5432/pg_auto_failover?...`) — ez kell a köv.
lépéshez.

**Ajánlott**: a monitor↔node forgalom a node-ok közötti PRIVÁT hálózaton (WireGuard vagy a
hosting saját privát VLAN-ja) menjen, ne a publikus IP-ken — ugyanaz az elv, mint a Kör 1
Fázis 1-ben a DB-hozzáférésnél.

### F.3 Első data node — `api.schoollive.hu` (a jelenlegi primary)

A JELENLEGI, már futó Postgres-t vonjuk be `pg_autoctl`-lel (nem törli az adatokat):
```bash
sudo pg_autoctl create postgres \
  --pgdata /var/lib/postgresql/16/main \
  --auth trust \
  --ssl-self-signed \
  --hostname api.schoollive.hu \
  --monitor "postgres://autoctl_node@<monitor-host>:5432/pg_auto_failover?..." \
  --run
```
`pg_autoctl` felismeri, hogy ez lesz az első/primary node a formationben.

### F.4 Második data node — `api1.schoollive.hu` (kezdeti standby)

```bash
sudo pg_autoctl create postgres \
  --pgdata /var/lib/postgresql/16/main \
  --auth trust \
  --ssl-self-signed \
  --hostname api1.schoollive.hu \
  --monitor "postgres://autoctl_node@<monitor-host>:5432/pg_auto_failover?..." \
  --run
```
Ez automatikusan `pg_basebackup`-pal lehúzza a teljes adatbázist a primary-ről, és
standby-ként csatlakozik.

### F.5 Systemd — mindhárom gépen

A `pg_autoctl create ... --run` már elindítja az `pg_autoctl run` folyamatot előtérben;
éles üzemhez systemd service-t generál a csomag (`pg_autoctl_data-*.service` vagy hasonló
néven, disztribúciónként eltérhet) — ellenőrizd:
```bash
sudo systemctl status pgautofailover 2>/dev/null || sudo systemctl status 'pg_autoctl@*' 2>/dev/null
sudo systemctl enable <a talált service neve>
```

### F.6 Ellenőrzés

```bash
pg_autoctl show state --pgdata /var/lib/postgresql/16/main
```
Mindkét data node-nak látszania kell, egyik `primary`, másik `secondary` állapotban.

### F.7 Lokális PgBouncer minden app-node-on

1. Telepítés: `sudo apt install pgbouncer`
2. `/etc/pgbouncer/pgbouncer.ini` — a `[databases]` szekció induló tartalma (a
   `ops/pgbouncer-target-sync.sh` ezt a sort írja majd felül automatikusan, de kell egy
   kezdő állapot):
   ```ini
   [databases]
   schoollive = host=127.0.0.1 port=5432 dbname=schoollive

   [pgbouncer]
   listen_addr = 127.0.0.1
   listen_port = 6432
   auth_type = md5
   auth_file = /etc/pgbouncer/userlist.txt
   admin_users = pgbouncer_admin
   ```
3. `/etc/pgbouncer/userlist.txt` — a Node app DB-usere ÉS egy `pgbouncer_admin` (csak a
   RELOAD parancshoz, a szinkron-szkript ezzel jelentkezik be) bekerül, szokásos PgBouncer
   md5-jelszó formátumban.
4. **Node app `.env` — MINDEN app-node-on ugyanaz**:
   ```
   DATABASE_URL=postgresql://<user>:<pass>@localhost:6432/schoollive
   ```
   Ez a sor innentől SOSEM változik, egyik node-on sem, függetlenül attól, melyik gépen
   fut épp a valódi primary.
5. `sudo systemctl enable --now pgbouncer`

### F.8 A célpont-szinkron szkript telepítése minden app-node-on

1. `ops/pg-ha.local.env` létrehozása (NEM git-elt, node-specifikus — ha az alapértelmezett
   `/var/lib/postgresql/16/main` PGDATA-út és a fenti pgbouncer-beállítások stimmelnek,
   ez a fájl akár el is maradhat, a szkript defaultjai jók):
   ```bash
   # /opt/schoollive/backend/ops/pg-ha.local.env
   PGDATA=/var/lib/postgresql/16/main
   PGBOUNCER_INI=/etc/pgbouncer/pgbouncer.ini
   PGBOUNCER_DB_ALIAS=schoollive
   PGBOUNCER_DB_NAME=schoollive
   PGBOUNCER_ADMIN_USER=pgbouncer_admin
   ```
2. Jogosultság: a szkript `postgres` user alatt fut (lásd `.service`), amelynek írási
   joga kell legyen `/etc/pgbouncer/pgbouncer.ini`-re (pl. `postgres` user a `pgbouncer`
   csoportba felvéve, és a fájl `664`-re, csoport `pgbouncer`) — állítsd be egyszer,
   telepítéskor.
3. Systemd egységek:
   ```bash
   sudo cp /opt/schoollive/backend/ops/pgbouncer-target-sync.service /etc/systemd/system/
   sudo cp /opt/schoollive/backend/ops/pgbouncer-target-sync.timer /etc/systemd/system/
   sudo systemctl daemon-reload
   sudo systemctl enable --now pgbouncer-target-sync.timer
   ```
4. **Ellenőrzés indításkor**: nézd meg a `pg_autoctl show state --pgdata ... --json | jq .`
   tényleges kimenetét, és hasonlítsd össze a szkript `reported_state=="primary"` jq
   szűrőjével — ha a telepített pg_auto_failover verzió eltérő mezőnevet ad, itt egy
   soros jq-igazítás kell (`ops/pgbouncer-target-sync.sh`, a `PRIMARY_HOST=`/`PRIMARY_PORT=`
   sorok).

### F.9 Kontrollált failover-teszt

1. Állítsd le a Postgres processzt a jelenlegi primary-n (`sudo systemctl stop postgresql`
   VAGY `pg_autoctl stop --pgdata ...` a tesztelt módtól függően).
2. Mérd az időt, amíg a monitor a standby-t promoveálja (`pg_autoctl show state` a
   monitor gépen, várhatóan ~10-30mp).
3. Ellenőrizd, hogy MINDEN app-node PgBouncer-e ~10mp-en belül (a timer ciklusa) átvált
   az új primary-re, zökkenőmentesen (nézd az app logokat — nem szabadna DB-hiba miatt
   crash-elnie).
4. Indítsd újra a leállított node-ot — `pg_autoctl` magától standby-ként csatlakozik
   vissza (`pg_rewind`/`pg_basebackup`).

### F.10 A régi primary-szerep VISSZAVÉTELE (kézi lépés, ahogy egyeztettük)

A user explicit döntése alapján ez NEM automatikus:
```bash
pg_autoctl perform switchover --pgdata /var/lib/postgresql/16/main
```
Ezt csak akkor futtasd, amikor a visszatért node már teljesen szinkronban van (`pg_autoctl
show state` mindkettőt egyező LSN-nel/`secondary`+`primary` állapotban mutatja), és —
összhangban a csengetés-tudatos időablak-szabállyal — NEM csengetés 5 perces közelében
vagy szünetben.

---

## Karbantartási megjegyzések

- Új app-node hozzáadásakor: `ops/nodes.txt` bővítése, GH Actions `DEPLOY_HOSTS` bővítése,
  a fenti E. és F. lépéssor megismétlése az új gépen (F. csak akkor, ha az új node
  Postgres-adatnode is lesz — ha csak app-node PgBouncer-rel, akkor elég az F.7-F.8).
- A rsync mesh kulcs és a monitor connection string BIZALMAS — ne kerüljön git-be
  (`ops/pg-ha.local.env` és a mesh privát kulcs is git-figyelmen kívül marad).
