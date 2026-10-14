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
  const pathname = pageLocation.pathname;
  return (
    isSupportedGoogleFormsPage(pageLocation) &&
    !/^\/forms\/u\/[^/]+\/?$/.test(pathname) &&
    !/\/edit\/?$/.test(pathname)
  );
}
