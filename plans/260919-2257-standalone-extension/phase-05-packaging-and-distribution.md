# Phase 05 — Packaging and distribution

Depends on: 04.

## What changed about selling

Under the SaaS model, payment gated an API. Under this model, the user runs everything locally with their own key. There is no server to refuse them. That reframes the whole question.

## 5.1 Licensing — decide honestly

**Open source, accept sponsorship.** No enforcement code, contributions possible, fastest adoption in a niche where developers inspect what they install. Income is unreliable.

**Paid one-time with a licence key.** Real revenue per user. But the extension is JavaScript running on the user's machine: any check can be removed by anyone willing to edit a file. A licence key is a speed bump and an honesty signal, not protection.

**Paid, no technical enforcement.** Sell it, ask people to pay, do not build a check. Some indie tools do well this way.

Recommendation: do not build licence enforcement that can be bypassed by deleting a line. Either accept that paying is voluntary, or pick a distribution channel that handles payment before download.

The realistic choice is between open source with sponsorship and a paid download through a storefront that gates access at the download step. Both avoid writing enforcement code that does not work.

## 5.2 Distribution

- **Cocos Store**: discovery by the exact audience, store handles delivery. Review process and rules to confirm.
- **Direct download from a site**: full control, needs traffic from somewhere.
- **GitHub releases**: simplest, credible for developer tools, good with open source.

Whichever is chosen, the install path must be short. The current install — Extension Manager, import folder, enable, reload — is already several steps. Do not add more.

## 5.3 First-run experience

This decides whether someone becomes a user. On first open, the user has no PixelLab key and may not know they need one.

The panel should state plainly: this tool needs a PixelLab API key, here is where to get one, here is roughly what a generation costs you. Then validate the key (Phase 02) and confirm it works before the first generation.

A user who pastes a key, generates a sprite, and sees it appear in their project within a couple of minutes will keep the tool. One who gets an opaque failure will not.

## 5.4 Versioning and compatibility

Two moving targets outside our control:

- **Cocos Creator**: `package.json` declares `>=3.8.0 <3.9.0`. When 3.9 ships, the extension will refuse to load. Have a plan.
- **PixelLab API**: they may change endpoints or pricing; their terms reserve that right. Endpoint names like `/animate-with-text-v3` and `/generate-8-rotations-v3` are already versioned, which suggests churn. A breaking change means users with an old build get failures that look like our bug.

Report the extension version in error messages, and detect an unexpected provider response shape clearly rather than failing obscurely.

## 5.5 Support surface

No accounts, no server, no logs — support is the user describing what they saw.

- A way to export a diagnostic bundle: versions, settings, recent errors, **with the API key redacted**.
- Documented common failures: bad key, exhausted quota, PixelLab down, QA rejection, Creator version mismatch.
- A stated response expectation, even if it is "best effort".

## 5.6 Before release

- [ ] Fresh Creator 3.8 install, clean project, full flow works.
- [ ] Works on Windows and macOS. No native binary means this should hold — confirm rather than assume.
- [ ] Bundle contains no secret, no telemetry, no call to anywhere but PixelLab.
- [ ] Documentation matches the shipped behaviour.
- [ ] A user who has never seen the tool can go from install to sprite unaided.
- [ ] Multi-direction defect resolved or clearly disclosed — `top_down_rpg` currently promises eight directions and delivers one.
- [ ] `precise` mode either working or absent from the UI.

The last two matter: shipping a preset that silently under-delivers is the kind of thing that produces refund requests and bad reviews in week one.

## Risks

| Risk                                                     | Mitigation                                                     |
| -------------------------------------------------------- | -------------------------------------------------------------- |
| Licence enforcement that anyone can strip                | Do not build it; gate at download or accept voluntary payment. |
| Cocos 3.9 breaks the extension                           | Declared range fails loudly; plan an update path.              |
| PixelLab changes its API and old builds break            | Version in errors; detect unexpected shapes explicitly.        |
| Users blame the tool for their own quota or key problems | Validate key on entry; distinguish failure classes clearly.    |
| Diagnostic bundle leaking the user's API key             | Redaction asserted by test, not by care.                       |

## Open questions

1. Open source with sponsorship, or paid through a storefront?
2. Cocos Store, direct, or GitHub releases?
3. Is any telemetry collected? Recommend none — it is a local tool, and none is the easiest privacy policy to write.
4. What is promised about Cocos 3.9 support?
