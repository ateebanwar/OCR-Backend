export interface ApiSuccessResponse<T> {
  success: true;
  data: T;
  requestId: string;
}

export interface ApiErrorBody {
  code: string;
  message: string;
  details?: unknown;
}

export interface ApiErrorResponse {
  success: false;
  error: ApiErrorBody;
  requestId: string;
}

export function formatSuccessResponse<T>(data: T, requestId: string): ApiSuccessResponse<T> {
  return {
    success: true,
    data,
    requestId,
  };
}

export function formatErrorResponse(
  code: string,
  message: string,
  requestId: string,
  details?: unknown
): ApiErrorResponse {
  return {
    success: false,
    error: {
      code,
      message,
      ...(details !== undefined ? { details } : {}),
    },
    requestId,
  };
}
