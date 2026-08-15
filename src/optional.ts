/** Assign an optional property while preserving absent-key semantics. */
export const assignOptional = <Target extends object, Key extends keyof Target>(
  target: Target,
  key: Key,
  value: Target[Key] | undefined,
): void => {
  if (value !== undefined) Object.assign(target, { [key]: value });
};
