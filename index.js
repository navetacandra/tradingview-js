const WebSocket = require("ws");
const crypto = require("crypto");

const INTERVAL = {
  min_1: "1",
  min_3: "3",
  min_5: "5",
  min_15: "15",
  min_30: "30",
  min_45: "45",
  hour_1: "1H",
  hour_2: "2H",
  hour_3: "3H",
  hour_4: "4H",
  daily: "1D",
  weekly: "1W",
  monthly: "1M",
};

class TradingViewData {
  constructor() {
    this.token = "unauthorized_user_token";
    this.ws = null;
    this.session = this.generateSession("qs");
    this.chartSession = this.generateSession("cs");
    this.wsDebug = false;
    this.wsTimeout = 5000;

    this.searchUrl = (text, exchange) =>
      `https://symbol-search.tradingview.com/symbol_search/v3/?text=${text}&hl=1&exchange=${exchange}&lang=en&search_type=undefined&domain=production&sort_by_country=US&promo=true`;
  }

  generateSession(prefix) {
    const id = crypto.randomUUID().replace(/-/g, "").slice(0, 12);
    return `${prefix}_${id}`;
  }

  prependHeader(str) {
    return `~m~${str.length}~m~${str}`;
  }

  constructMessage(func, params) {
    return JSON.stringify({ m: func, p: params });
  }

  createMessage(func, params) {
    return this.prependHeader(this.constructMessage(func, params));
  }

  sendMessage(func, args) {
    const msg = this.createMessage(func, args);
    if (this.wsDebug) console.log("Sending:", msg);
    this.ws.send(msg);
  }

  createConnection() {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(
        "wss://data.tradingview.com/socket.io/websocket",
        {
          headers: { Origin: "https://data.tradingview.com" },
        }
      );

      this.ws.on("open", resolve);
      this.ws.on("error", reject);
    });
  }

  parseData(rawData, symbol) {
    const match = /"s":\[(.+?)\}\]/.exec(rawData);
    if (!match) {
      console.error("No data, please check the exchange and symbol");
      return [];
    }

    const parts = match[1].split(',{"');
    const data = {
      timestamp: [],
      open: [],
      high: [],
      low: [],
      close: [],
      volume: [],
    };

    for (const part of parts) {
      const items = part.replace(/[\[\]:{}]/g, "").split(",");
      items[1] = items[1].replace('"v"', "");

      data.timestamp.push(parseFloat(items[1]) * 1000);
      data.open.push(parseFloat(items[2]));
      data.high.push(parseFloat(items[3]));
      data.low.push(parseFloat(items[4]));
      data.close.push(parseFloat(items[5]));
      data.volume.push(parseFloat(items[6]));
    }

    return data;
  }

  async getHist({
    symbol,
    interval = INTERVAL.daily,
    nBars = 10,
    extended = false,
    currency_code = "USD",
  }) {
    const formattedSymbol = symbol;
    await this.createConnection();

    this.sendMessage("set_auth_token", [this.token]);
    this.sendMessage("chart_create_session", [this.chartSession, ""]);
    this.sendMessage("quote_create_session", [this.session]);

    this.sendMessage("quote_set_fields", [
      this.session,
      ...[
        "ch",
        "chp",
        "current_session",
        "description",
        "local_description",
        "language",
        "exchange",
        "fractional",
        "is_tradable",
        "lp",
        "lp_time",
        "minmov",
        "minmove2",
        "original_name",
        "pricescale",
        "pro_name",
        "short_name",
        "type",
        "update_mode",
        "volume",
        "currency_code",
        "rchp",
        "rtc",
      ],
    ]);

    this.sendMessage("quote_add_symbols", [
      this.session,
      formattedSymbol,
      { flags: ["force_permission"] },
    ]);
    this.sendMessage("quote_fast_symbols", [this.session, formattedSymbol]);

    this.sendMessage("resolve_symbol", [
      this.chartSession,
      "symbol_1",
      `={"symbol":"${formattedSymbol}","adjustment":"splits","session":"${
        extended ? "extended" : "regular"
      }","currency-id":"${currency_code}"}`,
    ]);

    this.sendMessage("create_series", [
      this.chartSession,
      "s1",
      "s1",
      "symbol_1",
      interval,
      nBars,
    ]);
    this.sendMessage("switch_timezone", [this.chartSession, "exchange"]);

    let rawData = "";

    return new Promise((resolve, reject) => {
      this.ws.on("message", (data) => {
        rawData += data;
        if (data.includes("series_completed")) {
          this.ws.close();
          const parsed = this.parseData(rawData, formattedSymbol);
          resolve(parsed);
        }
      });

      this.ws.on("error", (err) => {
        reject(err);
      });
    });
  }

  async search(text, exchange = "") {
    const url = this.searchUrl(text, exchange);
    try {
      const res = await (
        await import("ky")
      ).default
        .get(url, {
          headers: {
            accept: "*/*",
            "accept-language": "en-US,en;q=0.9",
            dnt: "1",
            origin: "https://www.tradingview.com",
            priority: "u=1, i",
            referer: "https://www.tradingview.com/",
            "sec-ch-ua": '"Not.A/Brand";v="99", "Chromium";v="136"',
            "sec-ch-ua-mobile": "?0",
            "sec-ch-ua-platform": '"Windows"',
            "sec-fetch-dest": "empty",
            "sec-fetch-mode": "cors",
            "sec-fetch-site": "same-site",
            "user-agent":
              "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36",
          },
        })
        .json();
      return res.symbols.map(s => ({ type: s.type, exchange: s.exchange, symbol: `${s.prefix ?? s.source_id}:${s.symbol.replace(/<\/?em>/g, '')}`, description: s.description, currency_code: s.currency_code, s }));
    } catch (err) {
      console.error("Search error:", err.message);
      return [];
    }
  }
}

module.exports.currencies = require("./currencies.json");
module.exports.INTERVAL = INTERVAL;
module.exports.TradingViewData = TradingViewData;
