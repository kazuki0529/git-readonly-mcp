import { isAbsolute, relative, sep } from 'node:path';

/** candidateがroot自身またはその子孫に含まれるかを判定する。 */
export function containsPath(root: string, candidate: string): boolean {
  const difference = relative(root, candidate);
  return difference === ''
    || (!isAbsolute(difference) && difference !== '..' && !difference.startsWith(`..${sep}`));
}
