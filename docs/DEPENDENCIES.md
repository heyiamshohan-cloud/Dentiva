# Dentiva — third-party components and licences

Dentiva 1.0.0 · build 100 · database schema v10

This document is the complete licence audit for a shipped Dentiva build. It is the file the
`LICENSE` refers to, and the same notices ship inside every release archive as
`THIRD-PARTY-NOTICES.txt`.

Dentiva itself is proprietary commercial software (© 2026 Md. Shohan Khan). The components
below remain the property of their authors and are redistributed under their own permissive
licences, with the notices reproduced in full at the end of this document.

---

## 1. What is actually inside the executable

| Component | Version | Licence | Why it is included |
| --- | --- | --- | --- |
| Bun runtime | 1.4.2 | MIT | The application is compiled to a native executable with `bun build --compile`, so the runtime (JavaScript engine, standard library, SQLite driver) is embedded in `DENTIVA.exe` |
| SQLite | 3.5x, as bundled by Bun | Public domain | The entire clinic database; accessed through `bun:sqlite` (also embedded) |
| Inter | 5.2.6 (`@fontsource/inter`) | SIL Open Font License 1.1 | User-interface font for Latin text, embedded as `.woff2` inside the executable so no font needs to be installed |
| Noto Sans Bengali | 5.2.6 (`@fontsource/noto-sans-bengali`) | SIL Open Font License 1.1 | Bengali user-interface font, including correct conjunct shaping, embedded the same way |

That is the complete list. There is **no** PDF library, no image library, no analytics SDK, no
crash reporter, no cloud SDK, no authentication provider and no other third-party package in the
shipped application — a design decision taken so that a clinic can run Dentiva for years without
a licence expiring, a subscription lapsing or a data-protection review failing.

## 2. Development-only packages (never shipped)

These are used to build and test the project. They are not embedded in `DENTIVA.exe` and do not
ship in the release archive:

| Package | Version | Licence | Purpose |
| --- | --- | --- | --- |
| `jsdom` | 30.1.0 | MIT | Headless renderer sweep (`bun run qa:renderer`) — renders every screen and fails on a console error |
| `typescript` | 5.9.2 | Apache-2.0 | Type checking the JavaScript/JSDoc codebase (`bun x tsc --noEmit`) |
| `@types/bun` | 1.4.2 | MIT | Type definitions for the Bun APIs |
| `@fontsource/inter` | 5.2.6 | OFL-1.1 | Source of the shipped Inter `.woff2` files |
| `@fontsource/noto-sans-bengali` | 5.2.6 | OFL-1.1 | Source of the shipped Noto Sans Bengali `.woff2` files |

The build script (`scripts/build-win.mjs`) and the executable stamper (`scripts/stamp-exe.mjs`)
use only the Bun toolchain, Node's built-in modules
and the project's own code.

## 3. Services

None. Dentiva requires no paid or free online service, no API key, no account and no internet
connection at any point. Nothing is sent off the machine: there is no telemetry, no crash
reporting, no update check and no analytics. Patient data leaves the computer only when a
person exports or backs it up deliberately.

## 4. Redistribution checklist

When you ship a Dentiva build to a clinic, include:

1. `LICENSE` (the Dentiva licence),
2. this file or `THIRD-PARTY-NOTICES.txt` (identical content),
3. the unmodified `DENTIVA.exe`.

You do not need to include any toolchain or development package. If you build Dentiva yourself
with a different Bun version than the one listed above, update the version numbers here — the
licences themselves do not change.

---

## Notices

### Bun

```
Copyright (c) 2022-present Jarred Sumner and contributors
Copyright (c) Bun contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

### SQLite

```
The author disclaims copyright to this source code. In place of a legal
notice, here is a blessing:

   May you do good and not evil.
   May you find forgiveness for yourself and forgive others.
   May you share freely, never taking more than you give.
```

SQLite is in the public domain. No licence text is required for redistribution.

### Inter (SIL Open Font License 1.1)

```
Copyright (c) 2016 The Inter Project Authors (https://github.com/rsms/inter)

This Font Software is licensed under the SIL Open Font License, Version 1.1.
This license is copied below, and is also available with a FAQ at:
https://openfontlicense.org

-----------------------------------------------------------
SIL OPEN FONT LICENSE Version 1.1 - 26 February 2007
-----------------------------------------------------------

PREAMBLE
The goals of the Open Font License (OFL) are to stimulate worldwide
development of collaborative font projects, to support the font creation
efforts of academic and linguistic communities, and to provide a free and
open framework in which fonts may be shared and improved in partnership
with others.

The OFL allows the licensed fonts to be used, studied, modified and
redistributed freely as long as they are not sold by themselves. The
fonts, including any derivative works, can be bundled, embedded,
redistributed and/or sold with any software provided that any reserved
names are not used by derivative works. The fonts and derivatives,
however, cannot be released under any other type of license. The
requirement for fonts to remain under this license does not apply to any
document created using the fonts or their derivatives.

DEFINITIONS
"Font Software" refers to the set of files released by the Copyright
Holder(s) under this license and clearly marked as such. This may include
source files, build scripts and documentation.

"Reserved Font Name" refers to any names specified as such after the
copyright statement(s).

"Original Version" refers to the collection of Font Software components as
distributed by the Copyright Holder(s).

"Modified Version" refers to any derivative made by adding to, deleting,
or substituting -- in part or in whole -- any of the components of the
Original Version, by changing formats or by porting the Font Software to a
new environment.

"Author" refers to any designer, engineer, programmer, technical writer or
other person who contributed to the Font Software.

PERMISSION & CONDITIONS
Permission is hereby granted, free of charge, to any person obtaining a
copy of the Font Software, to use, study, copy, merge, embed, modify,
redistribute, and sell modified and unmodified copies of the Font
Software, subject to the following conditions:

1) Neither the Font Software nor any of its individual components, in
Original or Modified Versions, may be sold by itself.

2) Original or Modified Versions of the Font Software may be bundled,
redistributed and/or sold with any software, provided that each copy
contains the above copyright notice and this license. These can be
included either as stand-alone text files, human-readable headers or in
the appropriate machine-readable metadata fields within text or binary
files as long as those fields can be easily viewed by the user.

3) No Modified Version of the Font Software may use the Reserved Font
Name(s) unless explicit written permission is granted by the corresponding
Copyright Holder. This restriction only applies to the primary font name as
presented to the users.

4) The name(s) of the Copyright Holder(s) or the Author(s) of the Font
Software shall not be used to promote, endorse or advertise any Modified
Version, except to acknowledge the contribution(s) of the Copyright
Holder(s) and the Author(s) or with their explicit written permission.

5) The Font Software, modified or unmodified, in part or in whole, must be
distributed entirely under this license, and must not be distributed under
any other license. The requirement for fonts to remain under this license
does not apply to any document created using the Font Software.

TERMINATION
This license becomes null and void if any of the above conditions are not met.

DISCLAIMER
THE FONT SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO ANY WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT OF
COPYRIGHT, PATENT, TRADEMARK, OR OTHER RIGHT. IN NO EVENT SHALL THE
COPYRIGHT HOLDER BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY,
INCLUDING ANY GENERAL, SPECIAL, INDIRECT, INCIDENTAL, OR CONSEQUENTIAL
DAMAGES, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING
FROM, OUT OF THE USE OR INABILITY TO USE THE FONT SOFTWARE OR FROM OTHER
DEALINGS IN THE FONT SOFTWARE.
```

### Noto Sans Bengali (SIL Open Font License 1.1)

```
Copyright 2015-2024 Google LLC

This Font Software is licensed under the SIL Open Font License, Version 1.1
(the full text is reproduced above and is available at
https://openfontlicense.org).
```

### jsdom (development only)

```
Copyright (c) 2010 Elijah Insua
Copyright (c) 2011-2024 jsdom contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

### TypeScript (development only)

```
Copyright (c) Microsoft Corporation.

Licensed under the Apache License, Version 2.0 (the "License"); you may not
use this file except in compliance with the License. You may obtain a copy of
the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS, WITHOUT
WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied. See the
License for the specific language governing permissions and limitations under
the License.
```

### @types/bun (development only)

```
Copyright (c) DefinitelyTyped contributors.

This project is licensed under the MIT License — see
https://github.com/DefinitelyTyped/DefinitelyTyped/blob/master/LICENSE
```
