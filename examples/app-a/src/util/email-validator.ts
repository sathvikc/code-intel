// Email validator — uses a module-scope regex with the `g` flag.
//
// IMPLEMENTATION NOTE: this file demonstrates the canonical P17 / D23
// bug pattern. RegExp.prototype.test() advances lastIndex after every
// successful match; the second call against the same input returns
// false. Because EMAIL_RE is module-scope, every isEmail() call shares
// the same lastIndex state, and validation flips on alternate calls.
// Fix: drop the `g` flag (we don't need it for boolean validation), or
// declare the regex inside isEmail() so each call gets a fresh
// instance, or reset EMAIL_RE.lastIndex = 0 at the top of isEmail().

const EMAIL_RE = /\S+@\S+/g;

export function isEmail(input: string): boolean {
  return EMAIL_RE.test(input);
}
