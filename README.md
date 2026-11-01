# LEMONATE

Live price lookup **by ISIN** for Google Sheets. One custom function that works for bonds (BTP, corporate, Eurobonds), stocks, ETFs/ETCs, funds and certificates.

```
=LEMONATE(A2, N2)
```

Returns the price of the instrument whose ISIN is in `A2`, or the value of `N2` if no price can be found.

---

## Table of contents

1. [Installation](#installation)
2. [Functions](#functions)
3. [How the price is found](#how-the-price-is-found)
4. [Caching](#caching)
5. [Status and error messages](#status-and-error-messages)
6. [Troubleshooting](#troubleshooting)
7. [Limits and notes](#limits-and-notes)

---

## Installation

1. Open your Google Sheet.
2. Go to **Extensions → Apps Script**.
3. Delete the existing code and paste the full content of `LEMONATE.gs`.
4. Click **Save**.
5. Select the `testLemonate` function in the toolbar and click **Run**. Accept the permission prompt (needed to make external web requests).
6. Open **Executions** (or **View → Logs**) to read the result for the sample ISINs.
7. Go back to the sheet and use the formulas below.

> If your spreadsheet locale uses `;` as argument separator (for example Italian), write `=LEMONATE(A2; N2)`.

---

## Functions

### `LEMONATE(isin, fallbackValue, source)`

| Argument | Required | Description |
|---|---|---|
| `isin` | yes | ISIN code of the instrument (a single cell, e.g. `A2`). Spaces and hyphens are ignored, lower case is accepted. |
| `fallbackValue` | no | Value or cell returned when no price is found (e.g. `N2`). Defaults to `100`. |
| `source` | no | `"AUTO"` (default), `"BORSA"` (Borsa Italiana only) or `"YAHOO"` (Yahoo Finance only). |

Returns the price as a number, or the fallback value.

```
=LEMONATE(A2)                 price, or 100 if not found
=LEMONATE(A2, N2)             price, or the content of N2 if not found
=LEMONATE(A2, N2, "BORSA")    only Borsa Italiana
=LEMONATE(A2, N2, "YAHOO")    only Yahoo Finance
```

### `LEMONATE_INFO(isin, includeHeader, source)`

Diagnostic version: shows where the price comes from, or why none was found.

```
=LEMONATE_INFO(A2, TRUE)
```

Output columns:

| ISIN | Price | Currency | Source | Price type | Price date | Name | Status |
|---|---|---|---|---|---|---|---|

* `Price type` is `Reference price`, `Last trade`, `Official price`, `Last price` or `Previous close`.
* `Status` is `OK`, `OK (cached)` or the reason why no price was found.
* `includeHeader` is optional: `TRUE` adds the header row.

### Helper functions (run from the Apps Script editor)

| Function | What it does |
|---|---|
| `testLemonate()` | Looks up a few sample ISINs (BTP, Eurobond, stock, ETF and one invalid ISIN) and writes the outcome to the log. Edit the `sample` list to test your own ISINs. |
| `clearLemonateCache()` | Invalidates every cached price and remembered source. Then force the sheet to recalculate (re-enter a formula or reopen the file). |

---

## How the price is found

1. **ISIN validation.** Format (2 letters + 9 letters/digits + 1 digit) and ISO 6166 check digit. An invalid ISIN never triggers a web request.
2. **Source order** (`AUTO` mode):
   * ISINs starting with `IT` or `XS` (Italian instruments and Eurobonds): **Borsa Italiana first**, then Yahoo Finance.
   * Every other ISIN: **Yahoo Finance first**, then Borsa Italiana.
3. **Borsa Italiana.** The instrument pages are requested in parallel, bonds first and everything else only if no bond page matches:

   | Group | Pages |
   |---|---|
   | 1 (bonds) | MOT government bonds, MOT bonds in EUR, EuroMOT Eurobonds, EuroTLX |
   | 2 (other) | Euronext Milan stocks, ETFplus ETFs/ETCs, SeDeX certificates/warrants, ExtraMOT |

   A page is accepted only if it contains the requested ISIN **and** a price label followed by a number. The price is read in this order:

   1. `Prezzo di riferimento` (reference price)
   2. `Ultimo contratto` / `Ultimo prezzo` (last trade)
   3. `Prezzo ufficiale` (official price)

   Bond prices are quoted as a **percentage of par value** (e.g. `101.55`). The currency is read from the page when available, and the reference date is returned for the reference price.
4. **Yahoo Finance.** The ISIN is resolved to a ticker (indices, currencies, crypto, futures and options are ignored, at most 3 candidates are tried), then the last market price is read; if missing, the previous close. Prices are in the **listing currency** of the ticker (for example `GBp` means pence). Prices are **not** converted.
5. The source that worked is remembered, so later refreshes need a single request.

---

## Caching

| What | Duration |
|---|---|
| Successful price | 10 minutes |
| Failed lookup | 2 minutes (avoids hammering the sources) |
| Remembered source (page or ticker) per ISIN | 6 hours (maximum allowed by Apps Script) |

Google Sheets only re-runs a custom function when the sheet recalculates (file opened, a precedent cell changed, formula re-entered). It does **not** refresh on a timer.

---

## Status and error messages

`LEMONATE` never breaks your formulas: on any problem it returns the fallback value and writes the reason to the log. `LEMONATE_INFO` shows the same reason in the `Status` column.

| Message | Meaning |
|---|---|
| `No ISIN provided` | The ISIN cell is empty. |
| `Invalid ISIN "…": it must be exactly 12 characters long` | Wrong length. |
| `Invalid ISIN "…": expected 2 letters, 9 letters/digits and 1 check digit` | Wrong format. |
| `Invalid ISIN "…": the check digit does not match (possible typo)` | The ISIN has a typo. |
| `Borsa Italiana: no price found for this ISIN` | None of the Borsa Italiana pages contains a price for it. If present, `(unexpected HTTP status …)` lists non-404 errors such as 403 or 429. |
| `Yahoo Finance: no instrument found for this ISIN` | Yahoo search returned nothing for the ISIN. |
| `Yahoo Finance: rate limit reached (HTTP 429), try again in a few minutes` | Yahoo is throttling the requests (shared Google IPs). Yahoo is skipped for this lookup. |
| `Yahoo Finance search: unexpected HTTP status …` / `Yahoo Finance …: no market data` / `no valid price` | Yahoo answered, but without a usable price. |
| `Network error: …` | The request could not be completed. |
| `Time budget exceeded (custom functions are limited to 30 seconds)` | The lookup was stopped to stay inside the Google limit. |

Two cases show a real error in the cell (`#ERROR!`) because they are usage mistakes:

* `LEMONATE expects a single ISIN cell, not a range. Enter the formula in one cell and fill it down.`
* `Invalid source "…". Use "AUTO", "BORSA" or "YAHOO".`

---

## Troubleshooting

* **I always get the fallback value.** Use `=LEMONATE_INFO(A2, TRUE)` and read the `Status` column.
* **The price does not change.** The result is cached for 10 minutes, and Sheets does not recalculate on its own. Run `clearLemonateCache()` and re-enter the formula.
* **The price is not the one I expected.** Check `Source` and `Price type` in `LEMONATE_INFO`. Use the third argument (`"BORSA"` or `"YAHOO"`) to force a source.
* **Yahoo returns a price in the wrong unit.** Yahoo prices are in the listing currency (`GBp` = pence, not pounds). Check the `Currency` column.
* **`Service invoked too many times` or quota errors.** Apps Script limits daily web requests. Keep the cache enabled, avoid hundreds of unique ISINs recalculating at once, and wait for the quota to reset.
* **A type of instrument is not found.** Open its Borsa Italiana page in your browser, copy the address and share it: the page pattern can be added to `LEMONATE_BORSA_PAGES` in the script.

---

## Limits and notes

* Prices come from public web pages and are provided **as is**, with no guarantee of accuracy or timeliness. They are not investment advice.
* The Borsa Italiana page layout can change at any time; if it does, parsing may stop working until the script is updated.
* Bonds listed only on foreign venues and not on Borsa Italiana are usually not available on Yahoo Finance either, so they may not be found.
* Each custom function call is limited to **30 seconds** by Google; the script stops trying new sources after about 22 seconds.
* The ETF and ExtraMOT page addresses could not be verified when the script was written. If a page does not exist, the script simply moves on to the next one.
* The script was tested against simulated web responses; run `testLemonate()` in your own sheet to confirm live behaviour.

---

## Files

| File | Description |
|---|---|
| `LEMONATE.gs` | The Apps Script code (paste it into the script editor). |
| `README.md` | This document. |
