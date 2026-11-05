/** "1 issue", "2 issues", "6.5 issues": the noun agrees with the count. */
export function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}
