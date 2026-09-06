export const invitationStorageKey = "lira.pendingInvitation";
export function captureInvitation() {
  const match = /^#invite=([A-Za-z0-9_-]{43})$/.exec(location.hash);
  if (match) {
    sessionStorage.setItem(invitationStorageKey, match[1]!);
    history.replaceState(null, "", location.pathname + location.search);
    return match[1]!;
  }
  return null;
}
