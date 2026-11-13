# UDS Probe — MGU Store source (OTA, READ-ONLY)

**App id:** `uds_probe` · **Head unit:** iDrive 7 (`mguHmi: ["ID7"]`) · center-screen only.

Reads engine/gearbox basics — **rpm, speed, coolant, load, throttle, intake temp**
— purely over **read-only diagnostics**, with no car-data SOME/IP at all. A gear
read over UDS is attempted best-effort. Proves we can get live values on this car
even if the SOME/IP vehicle interfaces aren't exposed.

## Why it installs past the "nothing found" error

It declares **no car-data SOME/IP signals** — only the diagnostic transport
`InternalTasu` (marked `_optional`), which is present on this car (M Vitals and
the Fault Scanner use it). UDS/OBD reads **do not go through**
`generateSomeIpInterfaces`, so this app bypasses the failing step entirely.

## Safety — read-only

All reads go through `kit/readonly-diag.js` (`ReadOnlyDiag`). Its `check()` permits
only **0x22** (ReadDataByIdentifier), **0x01/0x09** (OBD read) and the `22 F1 50`
discovery broadcast; every write/reset/clear/routine/session/I-O service throws
before the bus. This app calls only OBD service **0x01** (to the DME, `0x12`) and
UDS **0x22** (gear-DID candidates to EGS `0x18` / DME `0x12`). Paced, safe while
driving.

- **rpm / speed / coolant / load / throttle / IAT** → standard OBD-II PIDs
  (`0C/0D/05/04/11/0F`) to the DME — reliable.
- **gear** → candidate UDS `0x22` DIDs to EGS/DME, reported **raw** (model-specific;
  may not be exposed — rpm/speed are the dependable reads).

## Install (GitHub OTA)

Commit this folder to a repo root (e.g. `sergshamiryan/mgu-uds-probe`), then in-car
**Store → Add source → branch → install UDS Probe**. It auto-reads on open.

## How to retrieve the output

Writes to a **USB stick** (if present) and the app data dir:

- **`uds_probe_report.json`** (raw) and **`uds_probe_report.txt`** (readable).

**USB:** pull the stick (files at root). **SSH:** `find /var/opt -name uds_probe_report.json` then `scp`.
Send me the `.json`.

## Caveats

- `InternalTasu` is marked optional, so the app installs even if it were absent —
  then it shows *"No diagnostic link"* and reads nothing. It is present on this car.
- The gear DID candidates are guesses; empty gear results are expected. rpm/speed/
  coolant via OBD are the dependable values.
- No `oap-sdk`/`node_modules` in this repo.
