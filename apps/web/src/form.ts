export function text(form: HTMLFormElement, name: string, trim = true) {
  const value = String(new FormData(form).get(name) ?? "");
  return trim ? value.trim() : value;
}
export function message(error: unknown) {
  return error instanceof Error ? error.message : "Something went wrong.";
}
