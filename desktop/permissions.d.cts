export declare const ALLOWED_PERMISSIONS: Set<string>;
export declare function createPermissionRule(opts: { scheme: string; devServer?: string | null }): (permission: string, url: unknown) => boolean;
