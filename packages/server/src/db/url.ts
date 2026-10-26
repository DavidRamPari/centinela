/** A database URL safe to print: the password is replaced with `***`. */
export function redactUrl(databaseUrl: string): string {
  const url = new URL(databaseUrl);
  if (url.password !== '') url.password = '***';
  return url.toString();
}
