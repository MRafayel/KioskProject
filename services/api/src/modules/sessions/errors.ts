export type ApiErrorDetails = Readonly<Record<string, string | number | boolean>>;

export class ApiError extends Error {
  public constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
    public readonly details?: ApiErrorDetails
  ) {
    super(message);
    this.name = "ApiError";
  }
}
