# Vendored third-party files

Everything the page loads at runtime is served from this repository, so a visit makes no requests to
third parties. The files are unmodified copies; verify them against the checksums below.

| File | Version | Source | Licence |
| --- | --- | --- | --- |
| `assets/vendor/gsap.min.js` | GSAP 3.12.5 | https://cdnjs.cloudflare.com/ajax/libs/gsap/3.12.5/gsap.min.js | [GSAP Standard License](https://gsap.com/standard-license) (free for use on websites) |
| `assets/vendor/lenis.min.js` | Lenis 1.1.13 | https://cdn.jsdelivr.net/npm/lenis@1.1.13/dist/lenis.min.js | MIT |
| `assets/fonts/Barlow-{400,500,600,700}.woff2` | Barlow, latin subset | Google Fonts (fonts.gstatic.com) | SIL Open Font License 1.1 |
| `assets/fonts/BarlowSemiCondensed-{500,600,700}.woff2` | Barlow Semi Condensed, latin subset | Google Fonts (fonts.gstatic.com) | SIL Open Font License 1.1 |

## SHA-256

```
28033e449a31ebcc396e5be8b13b63152bf03094288fb5867034321927bce087  assets/vendor/gsap.min.js
b2958f142f832f0d5e547cdef77e6fadfce16bea60982fc8bbf50395a2439df8  assets/vendor/lenis.min.js
b0a8ad37ac45f5fb22ced461576db72e44e295107aad7a9c8a7a4bad728fd03b  assets/fonts/Barlow-400.woff2
cd759df8ef9efc98fee14307b4eb5ba27f08b1f8f2f3ad2872432e25c89907a8  assets/fonts/Barlow-500.woff2
4b52ddd4836b592df0e4832b8286956883cdc651b015126bdd18f184b7f90cc3  assets/fonts/Barlow-600.woff2
2d797dd8b35dcb3413e1af9d7052b3f4f8c341a147cdcb01f4f06af80db53289  assets/fonts/Barlow-700.woff2
0d7513795eaf8fdab7f340144841bd2d9fac7d9303c03aa6b525a2c908e9b371  assets/fonts/BarlowSemiCondensed-500.woff2
f158417e9207b5362f9b71a2fe779ce5bb836ad972f38445c3163af39d2c998d  assets/fonts/BarlowSemiCondensed-600.woff2
fb958c8c20a05552ac8a85d925d96028d52565792650e941a5fe96b6997aa5cb  assets/fonts/BarlowSemiCondensed-700.woff2
```

From the `public/` folder, check your copies with `sha256sum assets/vendor/*.js assets/fonts/*.woff2` and compare. To upgrade a file, download
the new version, update the table and re-run `php tests/check.php` and the page in a browser.

## Font subset

Only the `latin` unicode range is bundled (see the `@font-face` rules at the top of `assets/css/styles.css`). Characters
outside it fall back to the system font.
