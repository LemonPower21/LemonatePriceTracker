# 🍋 LEMONATE –  Price Tracker for Google Sheets (EVEN FOR BONDS)

**LEMONATE** is a custom function for Google Sheets written in Google Apps Script. It allows you to automatically retrieve the **reference price** (or latest available market price) of a bond using its **ISIN code**.

The script first attempts to fetch data via the **Yahoo Finance API**. If the bond is not found or data is unavailable, it falls back to web scraping from **Borsa Italiana**. To ensure high performance and avoid hitting Google Apps Script quota limits, it features built-in 10-minute caching.

## 🌟 Key Features

* 🔎 **Multi-Source Lookup**: Automatically queries Yahoo Finance first, then falls back to Borsa Italiana.

* ⚡ **Optimized Performance**: Leverages `CacheService` to store prices for 10 minutes (600 seconds), significantly speeding up spreadsheet load times and preventing HTTP request throttling.

* 🛡️ **Fallback Management**: If the ISIN code is not found or no price is available, it gracefully returns a user-defined fallback value (e.g., `100` or a reference cell).

* 🇮🇹 **Italian Number Formatting**: Automatically converts European/Italian formatted number strings (e.g., `98,50` or `1.002,15`) into valid float numbers usable in formulas.

## 🛠️ Installation

1. Open your target spreadsheet in **Google Sheets**.

2. In the top menu, navigate to **Extensions** > **Apps Script**.

3. Delete any default code in the editor and paste the contents of `Lemonate.gs`.

4. Click the **Save** icon (💾) or press `Ctrl + S` (`Cmd + S` on Mac).

5. Return to your spreadsheet—the `=LEMONATE()` function is now ready to use!

## 🚀 Usage Guide

The function syntax is as follows:

```
=LEMONATE(isin, [fallbackValue])
```

### Parameters

| Parameter | Type | Required | Description |
| ----- | ----- | ----- | ----- |
| `isin` | `String` | **Yes** | The bond's ISIN code (e.g., `"IT0005436693"` or a cell reference like `A2`). |
| `fallbackValue` | `Number`/`String` | Optional | The value to return if the price cannot be retrieved. *(Default: `100`)* |

### Usage Examples

#### 1. Fetch price using a cell reference

If cell `A2` contains the ISIN code:

```
=LEMONATE(A2)
```

#### 2. Provide a custom fallback value

If the ISIN in `A2` is not found, the formula will return `99.5`:

```
=LEMONATE(A2, 99.5)
```

#### 3. Use another cell as fallback

If the ISIN is not found, return the cost/purchase price located in cell `N2`:

```
=LEMONATE(A2, N2)
```

## 🔄 How Caching Works

1. When `=LEMONATE("IT0005436693")` is evaluated, the script checks the document cache (`CacheService`).

2. **Cache Hit**: If the price was retrieved within the last 10 minutes, it is returned immediately without external HTTP requests.

3. **Cache Miss**:

   * Queries the **Yahoo Finance API**.

   * If missing, scrapes the security page on **Borsa Italiana**.

   * If a price is found, stores it in cache for **10 minutes** (600 seconds) and outputs the price.

   * If all sources fail, returns the specified `fallbackValue`.

## 📜 License

This project is licensed under the GNU GPL 3.0 License - free to use, modify, and distribute.
