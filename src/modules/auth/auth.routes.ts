import { Router } from "express";
import { postLogin, getMeHandler } from "./auth.controller";
import { authJwt } from "../../middleware/authJwt";
console.log("postLogin:", typeof postLogin, "getMeHandler:", typeof getMeHandler);

export const authRouter = Router();

authRouter.post("/login", postLogin);
authRouter.get("/me", authJwt, getMeHandler);
