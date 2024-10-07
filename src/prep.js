/*!
 *  Copyright (c) 2024, Rahul Gupta and Express PREP contributors.
 *
 *  This Source Code Form is subject to the terms of the Mozilla Public
 *  License, v. 2.0. If a copy of the MPL was not distributed with this
 *  file, You can obtain one at http://mozilla.org/MPL/2.0/.
 *
 *  SPDX-License-Identifier: MPL-2.0
 */
import cryptoRandomString from "crypto-random-string";
import { parseList, serializeDictionary } from "structured-headers";
import EventsFactory from "./engine.js";
import { rfc822 as rfc822Template } from "./templates.js";
import * as negotiate from "./negotiate.js";
import { useTry } from "no-try";
import stream from "node:stream";
import dedent from "dedent";

import Debug from "debug";
const debug = Debug("prep");

/**
 * The list of default content-types for notifications.
 * Can be modified using the environment variable `NOTIFICATIONS_CONTENT_TYPES`
 */
const CONTENT_TYPES =
  process.env.NOTIFICATIONS_CONTENT_TYPES || "message/rfc822";

/**
 * The default duration for the connection in seconds set to 1 hour.
 * Can be modified using the environment variable
 * `NOTIFICATIONS_CONTENT_DURATION`
 */
const CX_TIME = +(process.env.NOTIFICATIONS_DURATION || 3600);

/**
 * Maximum connection duration in seconds set to 2 hour.
 * Can be modified using the environment variable
 * `NOTIFICATIONS_CONTENT_DURATION_MAX`
 */
const CX_TIME_MAX = +(process.env.NOTIFICATIONS_DURATION_MAX || 7200);

/**
 * List of valid HTTP response codes for which PREP Notifications are sent.
 */
const VALID_STATUS_CODES = [200, 204, 206, 226];

/**
 * Adds extra items to a list header string.
 * If the header does not exist a new one is created.
 */
function appendToHeader(header, ...items) {
  const extraHeaders = items.join(", ");
  return `${header ?? ""}` ? `${header}, ${extraHeaders}` : extraHeaders;
}

/**
 *  Sequentially Merge Stream into Readable
 */
function mergeStream(str) {
  const pass = new stream.PassThrough({
    objectMode: false,
  });
  pass.on("pipe", (src) => {
    src.on("end", () => {
      str.pipe(pass);
      str.resume();
    });
    src.on("error", (err) => {
      pass.destroy(err);
    });
  });
  return pass;
}

/**
 * Append text at the end of a stream
 */
function appendStream(text) {
  return new stream.PassThrough({
    objectMode: false,
    flush(callback) {
      this.push(text);
      callback();
    },
  });
}

// Initialize the Events Engine for the middleware to use
const { subscribe, notify } = EventsFactory();

/**
 * PREP middleware function that is used to handle incoming HTTP requests and
 * generate notifications based on the request and response.
 * The middleware will add the following functions to the response:
 *  + `configureNotifications` - configures the `Accept-Events` response header
 *  + `sendPerResourceEvents` - to send a response with prep notifications
 *  + `triggerPerResourceEvent` - to trigger the notification,
 */
function prepMiddleware(req, res, next) {
  const { path, method } = req;
  const { statusCode } = res;

  /**
   * Set the Events Header
   */
  function setEventsHeader(eventsHeader) {
    res.setHeader("Events", serializeDictionary(eventsHeader));
  }

  /**
   * Allows the middleware consumer to specify notification supported on a
   * given path. It also sets the `Accepts-Events` header in the response.
   */
  function configureNotifications({ config: configuredEventsParams }) {
    const aePrepItem = `"prep";${configuredEventsParams || `accept=(${CONTENT_TYPES})`}`;

    // Parse the allowed fields identical to request header
    const [error, configuredEvents] = useTry(
      () => parseList(aePrepItem)?.[0][1],
    );

    // The acceptEvents header does not parse
    // This is a server mis-configuration
    if (error) {
      debug(dedent`
        Configured "Accept-Events" header does not parse for URL path ${path}.
        Define a proper response "Accept-Events" header
        ${error.message}
      `);
      return {
        protocol: "prep",
        status: 500,
      };
    }

    // Set the Accept-Events Header if the route supports PREP notifications
    const acceptEvents = res.getHeader("accept-events");
    res.setHeader("Accept-Events", appendToHeader(acceptEvents, aePrepItem));

    res.events.prep.config = configuredEvents;
  }

  /**
   * Allows the middleware consumer to send a response with notifications.
   */
  function sendResponseWithNotification({
    headers: responseHeaders = {},
    body: responseBody,
    isBodyStream = false,
    params: requestedEvents = new Map(),
    modifiers: {
      /**
       * Modifies the default content negotiation for notifications
       */
      negotiateEvents = (d) => d,
      /**
       * Modifies the default Events header in a response.
       */
      modifyEventsHeader = () => {},
    } = {},
  }) {
    /**
     * Stores fields for the `Events` Header.
     */
    const eventsHeader = {
      protocol: "prep",
    };

    // Check if response is legal
    if (!VALID_STATUS_CODES.includes(statusCode)) {
      debug("Response was not successful");
      eventsHeader.status = 412;
      return eventsHeader;
    }

    // Remove `q` as it is no longer necessary
    requestedEvents.delete("q");

    // Content Negotiation

    const configuredEvents = res.events.prep.config;

    if (!configuredEvents) {
      debug(`No events configuration defined for the route`);
      eventsHeader.status = 500;
      return eventsHeader;
    }

    // The server does not define an allowed media-type, something it must at a minimum.
    // This is a server mis-configuration
    if (!configuredEvents?.get("accept")) {
      debug(dedent`
        No acceptable media-type configured for for URL path ${path}.
        Define an "accept" field for the response "accept-events" header in your middleware configuration
      `);
      eventsHeader.status = 500;
      return eventsHeader;
    }

    if (!requestedEvents.has("accept")) {
      debug(`No "accept" events field defined in the request`);
    }

    const negotiatedEvents = negotiate.cleanUp(
      negotiateEvents(negotiate.content(requestedEvents, configuredEvents)),
    );

    if (negotiatedEvents) {
      debug("Found a matching content-type for notifications");
      eventsHeader.status = 200;
    } else {
      debug("No matched content-type for notifications");
      eventsHeader.status = 406;
      return eventsHeader;
    }

    // Vary header includes Accept-Events
    res.setHeader(
      "vary",
      appendToHeader(res.getHeader("vary"), "Accept-Events"),
    );

    // Connection Handling

    /**
     * Tracks the connection status.
     * It is initially set to `true` to indicate that the connection is active.
     * If the connection is closed or aborted, the value of `connected` will
     * be set to `false` to indicate that the connection is no longer active.
     */
    let connected = true;

    // Handle sudden connection drops
    res.on("close", () => disconnected("close"));
    res.on("finish", () => disconnected("finish"));
    req.on("abort", () => disconnected("abort"));

    /**
     * Check if user agent is firefox.
     * This will be used to add additional lines so that firefox does not
     * close the connection between notifications.
     */
    let is_firefox = false;

    if (
      req.headers["user-agent"] &&
      req.headers["user-agent"].toLowerCase().indexOf("firefox") > -1
    ) {
      is_firefox = true;
    }

    // Set Duration

    /**
     * The interval in seconds derived from the duration header.
     */
    const cxTimeH = +(requestedEvents.get("duration") || 0);

    /**
     * The interval in seconds for which the connection is to remain open.
     */
    const cxTime =
      cxTimeH && cxTimeH > 0 && cxTimeH <= CX_TIME_MAX ? cxTimeH : CX_TIME;

    /**
     * The expiration time for the connection.
     */
    const expires = new Date();
    expires.setTime(Date.now() + cxTime * 1000);
    setTimeout(closeConnection, cxTime * 1000);
    eventsHeader.expires = expires.toUTCString();

    // Handle the connection
    req.socket.server.timeout = 0.0;
    req.socket.server.keepAliveTimeout = cxTime * 1000 + 1000;

    /**
     * Retrieving the value of the "Last-Event-ID" header from the incoming
     * HTTP request.
     */
    const reqLastEventID = `${req.headers["last-event-id"] ?? ""}`;

    /**
     * A randomly generated boundary string for multipart/mixed content-type
     * that separates representation body from the notification body.
     * It will only be generated if representation is also sent.
     */
    let mixedBoundary;

    /**
     * A randomly generated boundary string for the separating notifications.
     */
    const digestBoundary = cryptoRandomString({ length: 20, type: "base64" });

    /**
     * A stream to capture notifications
     */
    const notifications = new stream.Readable({
      read() {},
    });
    // Do not send notifications until you write the headers (and representation).
    notifications.pause();

    /**
     * Boundary for notifications
     */
    const boundary = dedent`
      \n--${digestBoundary}
      ${is_firefox ? "\n".repeat(240) : ""}
      ${is_firefox ? `--${digestBoundary}` : ""}
    `.replace(/\n/g, "\r\n");

    /**
     * Writes the notification to the response.
     * (If the response is being sent to Firefox, it adds multiple line breaks
     * to prevent Firefox from closing the connection prematurely.)
     */
    function writeNotification(notification, last) {
      notifications.push(
        `\r\n${notification}${last ? `\r\n--${digestBoundary}` : boundary}`,
      );
    }

    /**
     * Writes the end of the response.
     * It writes the closing boundary for the notifications body
     * and ends the response.
     */
    function writeEnd() {
      notifications.push(
        dedent`
          --
          --${mixedBoundary}--\n
        `.replace(/\n/g, "\r\n"),
      );
      res.end();
    }

    // remove the `vary` field, if it exists
    delete negotiatedEvents.vary;

    // Add URL to subscription list
    const removeHandler = subscribe({
      path,
      negotiatedFields: negotiatedEvents,
      handler: writeNotification,
      endHandler: writeEnd,
    });

    /**
     * Callback function to handle disconnection.
     */
    function disconnected(cause) {
      if (!connected) return;
      connected = false;
      debug(`Connection closed on ${path} from ${cause} event`);

      // Now remove the handlers
      removeHandler();
    }

    /**
     * Function to close the connection.
     */
    function closeConnection() {
      writeEnd();
      connected = false;
      removeHandler();
    }

    setEventsHeader(
      Object.assign(eventsHeader, modifyEventsHeader(negotiatedEvents)),
    );

    const shouldSkipBody =
      responseBody &&
      (reqLastEventID === "*" ||
        (res.lastEventID && reqLastEventID === res.lastEventID));

    if (responseBody) {
      if (reqLastEventID) {
        res.setHeader(
          "Vary",
          appendToHeader(res.getHeader("Vary"), "Last-Event-ID"),
        );
      }
    }

    // Add to the Vary header only if the server defines it for the URL
    mixedBoundary = cryptoRandomString({ length: 20, type: "base64" });
    res.setHeader(
      "Content-Type",
      `multipart/mixed; boundary="${mixedBoundary}"`,
    );
    res.write(`--${mixedBoundary}\r\n`);
    // Write response headers in first part
    for (const header in responseHeaders) {
      res.write(`${header}: ${responseHeaders[header]}\r\n`);
    }
    res.write("\r\n"); // Empty line to separate headers

    const postResponse = `${dedent`
        \n--${mixedBoundary}
        Content-Type: multipart/digest; boundary="${digestBoundary}"\n
      `.replace(/\n/g, "\r\n")}${boundary}`;

    if (shouldSkipBody) {
      res.write(postResponse);
      notifications.pipe(res);
      notifications.resume();
    } else {
      if (isBodyStream) {
        responseBody
          .pipe(appendStream(postResponse))
          .pipe(mergeStream(notifications), { end: false })
          .pipe(res);
      } else {
        res.write(responseBody);
        res.write(postResponse);
        notifications.pipe(res);
        notifications.resume();
      }
    }
  }

  /**
   * The default Notification to send
   */
  function defaultNotification({
    // Date is a hack since nodejs does not seem to provide access to send date.
    date = res._header.match(/^Date: (.*?)$/m)?.[1] || new Date().toUTCString(),
    method = req.method,
    eTag,
    eventID = res.getHeader("Event-ID"),
    location = res.getHeader("Content-Location"),
    delta,
  } = {}) {
    return `\r\n${rfc822Template({
      date,
      method,
      ...(eTag && { eTag }),
      ...(eventID && { eventID }),
      ...(location && { location }),
      ...(delta && { delta }),
    })}`;
  }

  /**
   * Allows the middleware consumer to initiate a notification.
   */
  function triggerNotification({
    path = req.path,
    generateNotification = defaultNotification,
    lastEvent,
  } = {}) {
    (lastEvent = lastEvent ?? (path === req.path && method === "DELETE")),
      process.nextTick(() =>
        notify({
          path,
          generateNotification,
          lastEvent,
        }),
      );
  }

  res.events ??= {};
  res.events.prep = {
    configure: configureNotifications,
    send: sendResponseWithNotification,
    trigger: triggerNotification,
    defaultNotification,
  };

  return next && next();
}

export default prepMiddleware;
