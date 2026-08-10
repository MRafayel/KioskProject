/**
 * Quoting for the two role-provisioning tools.
 *
 * Identifiers and passwords cannot be bound as parameters in DDL, so `GRANT`,
 * `CREATE ROLE` and `ALTER ROLE` statements are assembled as text. Both tools
 * build the same kinds of statement, and this is the part of them where a
 * difference would matter, so they share one implementation rather than each
 * keeping a copy that is only correct until somebody edits one of them.
 */

/**
 * A role, table or column name, quoted — and refused outright if it is not a
 * plain identifier. Everything passed here comes from this repository or an
 * operator's environment rather than from a request, but an identifier that
 * reaches `GRANT` unquoted is the kind of thing that is only safe until it is
 * not.
 */
export function quoteIdentifier(value) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(value)) {
    throw new Error(`Refusing to use ${JSON.stringify(value)} as a SQL identifier.`);
  }
  return `"${value}"`;
}

/** A string literal for DDL that cannot take a bind parameter. */
export function quoteLiteral(value) {
  return `'${value.replaceAll("'", "''")}'`;
}
