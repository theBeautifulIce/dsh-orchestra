export declare const PACKAGE_GUIDES: readonly string[];
export declare const PUBLIC_PACKAGE_FILES: readonly string[];
export type ClientInjectRole = 'candidate' | 'previous';
export type ClientInjectProtocol =
  | 'dsh-orchestra/client-inject/g5/v1'
  | 'dsh-orchestra/client-inject/slash/v1'
  | 'dsh-orchestra/client-inject/conversation/v1'
  | 'dsh-orchestra/client-inject/workbench/v1';

export declare const CLIENT_INJECT_PROTOCOLS: Readonly<Record<ClientInjectProtocol, readonly string[]>>;
export declare const CLIENT_INJECT_ROLES: Readonly<{
  candidate: 'dsh-orchestra/client-inject/workbench/v1';
  previous: 'dsh-orchestra/client-inject/g5/v1';
}>;
export declare function assertClientInject(inject: unknown, role?: ClientInjectRole): ClientInjectProtocol;
