import { connect } from "node:net";
import { clearTimeout, setTimeout } from "node:timers";

export const DEV_CONTROL_NAME_PATTERN = /^[a-z0-9-]{1,32}$/;
const RESPONSE_TIMEOUT_MS = 5000;

export function sendRequest(name, command) {
  if (typeof name !== "string" || !DEV_CONTROL_NAME_PATTERN.test(name)) throw new Error("Invalid dev control name");
  return new Promise((resolve, reject) => {
    const socket = connect(`\\\\.\\pipe\\deskpet-dev-${name}`);
    let pending = "";
    let settled = false;
    const timer = setTimeout(() => socket.destroy(new Error("Dev control timed out")), RESPONSE_TIMEOUT_MS);
    function finish(error, result) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (error) reject(error);
      else resolve(result);
    }
    socket.setEncoding("utf8");
    socket.on("connect", () => socket.write(`${JSON.stringify({ ...command, id: 1 })}\n`));
    socket.on("data", (chunk) => {
      pending += chunk;
      const newline = pending.indexOf("\n");
      if (newline < 0) return;
      try {
        const response = JSON.parse(pending.slice(0, newline));
        if (response?.id !== 1) throw new Error("Dev control response id mismatch");
        if (response?.ok !== true) throw new Error(response?.error ?? "Invalid dev control response");
        finish(undefined, response.result);
      } catch (error) { finish(error); }
    });
    socket.on("end", () => finish(new Error("Dev control closed before responding")));
    socket.on("close", () => finish(new Error("Dev control disconnected before responding")));
    socket.on("error", (error) => finish(error));
  });
}
