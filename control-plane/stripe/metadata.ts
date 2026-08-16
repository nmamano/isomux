// The metadata keys we set at Checkout and read back from fetched objects.
//
// They live in their own module because both ends of the billing flow need
// them and the two ends must not need each other. `checkout.ts` writes them
// and `reconcile.ts` reads them; importing the reader to get a constant is
// what put the whole webhook path - and, through it, the ticker's type graph -
// into the module graph of anything that only wanted to open a Checkout
// session. The web app is the caller that made that visible: it opens Checkout
// and must not carry the code that processes webhooks.

export const META_ACCOUNT = "isomux_account";
export const META_EMAIL = "isomux_email";
export const META_OFFICE_NAME = "isomux_office_name";
export const META_INSTANCE = "isomux_instance";
export const META_REINSTATEMENT = "isomux_reinstatement";
