import { Router } from "express";
import {
  postLogin, postLogout, postRefresh, getMeHandler, patchMeLocale,
  getSessionsHandler, deleteSessionHandler,
} from "./auth.controller";
import { authJwt } from "../../middleware/authJwt";

export const authRouter = Router();

authRouter.post("/login",   postLogin);
authRouter.post("/logout",  postLogout); // token bodyból vagy headerből
authRouter.post("/refresh", authJwt, postRefresh);
authRouter.get("/me",       authJwt, getMeHandler);
authRouter.patch("/me/locale", authJwt, patchMeLocale);

// Multi-session: a hívó saját bejelentkezett kliensei (self-service lista +
// egyedi kijelentkeztetés).
authRouter.get("/sessions",     authJwt, getSessionsHandler);
authRouter.delete("/sessions/:id", authJwt, deleteSessionHandler);