export interface PageLocation {
  protocol: string;
  hostname: string;
  pathname: string;
}

export function isSupportedGoogleFormsPage(
  location: PageLocation | string
): boolean {
  const pageLocation =
    typeof location === 'string' ? new URL(location) : location;

  return (
    pageLocation.protocol === 'https:' &&
    pageLocation.hostname === 'docs.google.com' &&
    /^\/forms\/[^/]+(?:\/|$)/.test(pageLocation.pathname)
  );
}

export function isGoogleFormsRespondentPage(
  location: PageLocation | string
): boolean {
  const pageLocation =
    typeof location === 'string' ? new URL(location) : location;
  return (
    isSupportedGoogleFormsPage(pageLocation) &&
    /\/viewform\/?$/.test(pageLocation.pathname)
  );
}
