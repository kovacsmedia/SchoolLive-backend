import { Router } from "express";
import { postLogin, postLogout, getMeHandler } from "./auth.controller";
import { authJwt } from "../../middleware/authJwt";

export const authRouter = Router();

authRouter.post("/login",  postLogin);
authRouter.post("/logout", authJwt, postLogout);
authRouter.get("/me",      authJwt, getMeHandler);