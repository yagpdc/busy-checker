import type { NextFunction, Request, Response } from "express";
import jwt from "jsonwebtoken";
import { config } from "../config.js";

export interface SessionPayload {
  userId: number;
  email: string;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      session?: SessionPayload;
    }
  }
}

export function issueSession(payload: SessionPayload): string {
  return jwt.sign(payload, config.sessionSecret, { expiresIn: "30d" });
}

export function requireSession(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const header = req.header("authorization");
  if (!header?.startsWith("Bearer ")) {
    res.status(401).json({ error: "missing_token" });
    return;
  }
  try {
    const decoded = jwt.verify(
      header.slice("Bearer ".length),
      config.sessionSecret,
    ) as SessionPayload;
    req.session = decoded;
    next();
  } catch {
    res.status(401).json({ error: "invalid_token" });
  }
}
