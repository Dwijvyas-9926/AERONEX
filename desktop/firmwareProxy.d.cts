// Types for firmwareProxy.cjs, for the page's tests.
export const FIRMWARE_SERVER: string;
export function firmwareTarget(pathname: string): string | null;
export function proxyFirmware(request: Request, fetchFn: (url: string, init: object) => Promise<Response>): Promise<Response> | null;
