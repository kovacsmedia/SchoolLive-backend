import { Router } from "express";
import { postLogin, postLogout, postRefresh, getMeHandler, patchMeLocale } from "./auth.controller";
import { authJwt } from "../../middleware/authJwt";

export const authRouter = Router();

authRouter.post("/login",   postLogin);
authRouter.post("/logout",  postLogout); // token bodyból vagy headerből
authRouter.post("/refresh", authJwt, postRefresh);
authRouter.get("/me",       authJwt, getMeHandler);
authRouter.patch("/me/locale", authJwt, patchMeLocale);