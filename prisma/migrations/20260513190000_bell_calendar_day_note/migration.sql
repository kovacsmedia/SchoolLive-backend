-- BellCalendarDay: 16 karakteres opcionális megjegyzés.
-- A frontend a naptár-cellában is megjeleníti (pl. "Tanévnyitó",
-- "Felmérő", "Ülésrend"). Az admin a nap szerkesztésekor adja meg.

ALTER TABLE "BellCalendarDay"
  ADD COLUMN IF NOT EXISTS "note" VARCHAR(16);
