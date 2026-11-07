import {
  randomBytes,
  scrypt as scryptCallback,
  timingSafeEqual,
  createHash,
} from "node:crypto";
import { promisify } from "node:util";
const scrypt = promisify(scryptCallback);
export const hash = (value) => createHash("sha256").update(value).digest("hex");
export const token = () => randomBytes(32).toString("hex");
export async function passwordHash(password) {
  const salt = token();
  const key = await scrypt(password, salt, 64, {
    N: 32768,
    r: 8,
    p: 1,
    maxmem: 64 * 1024 * 1024,
  });
  return `scrypt:${salt}:${key.toString("hex")}`;
}
export async function passwordMatches(password, stored) {
  const [, salt, expected] = stored.split(":");
  const key = await scrypt(password, salt, 64, {
    N: 32768,
    r: 8,
    p: 1,
    maxmem: 64 * 1024 * 1024,
  });
  const original = Buffer.from(expected, "hex");
  return key.length === original.length && timingSafeEqual(key, original);
}
export const validPassword = (value) =>
  typeof value === "string" && value.length >= 12 && value.length <= 128;
