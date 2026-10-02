export type ErrorCode =
  | "INVALID_INPUT"
  | "NOT_FOUND"
  | "CONFLICT"
  | "INVALID_STATE";

export class ApiError extends Error {
  code: ErrorCode;
  status: number;
  constructor(code: ErrorCode, message: string) {
    super(message);
    this.code = code;
    this.status =
      code === "NOT_FOUND" ? 404 : code === "CONFLICT" ? 409 : 400;
  }
}

export function fail(code: ErrorCode, message: string): never {
  throw new ApiError(code, message);
}
