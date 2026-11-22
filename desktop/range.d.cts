export declare function byteRange(size: number, header: string | null | undefined): { status: 200 } | { status: 206; start: number; end: number } | { status: 416 };
