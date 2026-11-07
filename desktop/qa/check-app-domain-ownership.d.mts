export function appDomainViolations(source: string, requireOwners?: boolean): Array<{ line: number; rule: string; detail: string }>;
export function readAppDomainSource(): string;
