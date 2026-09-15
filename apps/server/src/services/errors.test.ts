// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { RouteError, errorBody, statusFor, toErrorResponse } from "./errors.js";

describe("RouteError / toErrorResponse", () => {
  it("maps a RouteError to its frozen status + body", () => {
    const err = new RouteError("SNAPSHOT_NOT_FOUND", "no such snapshot");
    const { status, body } = toErrorResponse(err);
    expect(status).toBe(404);
    expect(body).toEqual({ error_code: "SNAPSHOT_NOT_FOUND", message: "no such snapshot" });
  });

  it("maps a plain Error to INTERNAL_ERROR/500 without leaking a stack trace", () => {
    const { status, body } = toErrorResponse(new Error("something broke"));
    expect(status).toBe(500);
    expect(body.error_code).toBe("INTERNAL_ERROR");
    expect(body.message).toBe("something broke");
    expect(body).not.toHaveProperty("stack");
  });

  it("maps a non-Error throw to INTERNAL_ERROR without crashing", () => {
    const { status, body } = toErrorResponse("a string was thrown");
    expect(status).toBe(500);
    expect(body.error_code).toBe("INTERNAL_ERROR");
  });

  it("statusFor matches the frozen HTTP_STATUS_BY_ERROR_CODE table", () => {
    expect(statusFor("VALIDATION_FAILED")).toBe(422);
    expect(statusFor("CONFLICT")).toBe(409);
    expect(statusFor("TURN_ABORTED")).toBe(499);
  });

  it("errorBody produces the exact {error_code, message} shape", () => {
    expect(errorBody("TIMEOUT", "took too long")).toEqual({ error_code: "TIMEOUT", message: "took too long" });
  });
});
