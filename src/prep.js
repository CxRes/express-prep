/*!
 *  Copyright (c) 2024, Rahul Gupta
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

import Debug from "debug";
const debug = Debug("PREP");

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
const CX_TIME = +process.env.NOTIFICATIONS_DURATION || 3600;

/**
 * Maximum connection duration in seconds set to 2 hour.
 * Can be modified using the environment variable
 * `NOTIFICATIONS_CONTENT_DURATION_MAX`
 */
const CX_TIME_MAX = +process.env.NOTIFICATIONS_DURATION_MAX || 7200;

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
 * The PREP factory function that configures and generates the PREP middleware.
 */
function PREP({
  /**
   * A configuration function defining content negotiation for notifications
   */
  supportedEvents = () => `accept=%"${CONTENT_TYPES}"`,
  /**
   * A configuration function that allows the middleware to:
   * + set the Accept-Events header in a response,
   * + to check if PREP notification request can be served.
   */
  negotiateEvents = (requested, allowed) =>
    negotiate.cleanUp(negotiate.content(requested, allowed)),
  /**
   * A configuration function that allows the middleware to:
   * set the Events header in a response with negotiated fields
   */
  setEvents = () => {},
} = {}) {
  // Initialize the Events Engine for the middleware to use
  const { subscribe, notify } = EventsFactory();

  /**
   * PREP middleware function that is used to handle incoming HTTP requests and
   * generate notifications based on the request and response.
   * The middleware will add the following functions to the response:
   *  + `triggerPerResourceEvent` - to trigger the notification,
   *  + `sendPerResourceEvents` - to send a response with prep notifications
   */
  function prepMiddleware(req, res, next) {
    const { path, method } = req;
    const { statusCode } = res;

    // Set the Accept-Events Header if the route supports PREP notifications
    const acceptEvents = res.getHeader("accept-events");
    if (acceptEvents) {
      const configuredEvents = supportedEvents(path)?.toString();
      if (configuredEvents) {
        res.setHeader(
          "Accept-Events",
          appendToHeader(acceptEvents, `"prep";${configuredEvents}`),
        );
      }
    }

    /**
     * Set the Events Header
     */
    function setEventsHeader(eventFields) {
      res.setHeader("Events", serializeDictionary(eventFields));
    }

    /**
     * The function the server calls for sending a response with a notification.
     */
    function initializePerResourceEvents({ params: requestEventFields }) {
      /**
       * Stores fields for the `Events` Header.
       */
      const eventFields = {
        protocol: "prep",
      };

      // Check if response is legal
      if (!VALID_STATUS_CODES.includes(statusCode)) {
        (eventFields.status = 412), debug("Response was not successful");
        return eventFields;
      }

      // Remove `q` as it is no longer necessary
      requestEventFields.delete("q");

      // Content Negotiation

      // Parse the allowed fields identical to request header
      const [error, configuredFields] = useTry(
        () => parseList(`prep;${supportedEvents(path)}`)?.[0][1],
      );

      // The acceptEvents header does not parse
      // This is a server mis-configuration
      if (error) {
        debug(`Configured "Accept-Events" header does not parse for URL path ${path}.
Define a proper response "Accept-Events" header
${error.message}`);
        eventFields.status = 500;
        return eventFields;
      }

      // The server does not define an allowed media-type, something it must at a minimum.
      // This is a server mis-configuration
      if (!configuredFields.get("accept")) {
        debug(`No acceptable media-type configured for for URL path ${path}.
Define an "accept" field for the response "accept-events" header in your middleware configuration`);
        eventFields.status = 500;
        return eventFields;
      }

      if (!requestEventFields.has("accept")) {
        debug(`No "accept" events field defined in the request`);
      }

      const negotiatedEvents = negotiateEvents(
        requestEventFields,
        configuredFields,
      );

      if (negotiatedEvents) {
        debug("Found a matching content-type for notifications");
        res.prep.negotiatedEvents = negotiatedEvents;
        eventFields.status = 200;
      } else {
        debug("No matched content-type for notifications");
        eventFields.status = 406;
      }
      return eventFields;
    }

    function sendResponseWithNotification({
      events: eventFields,
      headers: responseHeaders,
      body: responseBody,
      params: requestEventFields,
    }) {
      // Vary header includes Accept-Events
      res.setHeader(
        "vary",
        appendToHeader(res.getHeader("vary"), "Accept-Events"),
      );

      if (!res.prep.negotiatedEvents) {
        debug("You need to run `res.prep.init` first");
      }

      const { negotiatedEvents } = res.prep;

      // Connnection Handling

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
      const cxTimeH = +requestEventFields.get("duration");

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
      eventFields.expires = expires.toUTCString();

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
       * A randomly generated boundary string for the separarting notifications.
       */
      const digestBoundary = cryptoRandomString({ length: 20, type: "base64" });

      setEventsHeader(Object.assign(eventFields, setEvents(negotiatedEvents)));

      const shouldSkipBody =
        !responseBody ??
        (reqLastEventID === "*" ||
          (res.lastEventID && reqLastEventID === res.lastEventID));

      if (shouldSkipBody) {
        debug("Serving only Notifications");
        res.setHeader(
          "Content-Type",
          `multipart/digest; boundary="${digestBoundary}"`,
        );
        res.setHeader(
          "Vary",
          appendToHeader(res.getHeader("Vary"), "Last-Event-ID"),
        );
        res.write("\r\n");
      } else {
        debug("Serving notifications with response");
        // Add to the Vary header only if the server defines it for the URL
        mixedBoundary = cryptoRandomString({ length: 20, type: "base64" });
        res.setHeader(
          "Content-Type",
          `multipart/mixed; boundary="${mixedBoundary}"`,
        );
        res.write(`--${mixedBoundary}`);
        res.write("\r\n");
        // Write response headers in first part
        for (const header in responseHeaders) {
          res.write(`${header}: ${responseHeaders[header]}`);
          res.write("\r\n");
        }
        res.write("\r\n"); // Manually because JS uses `\n` as linebreak
        res.write(responseBody);
        res.write(`\r\n--${mixedBoundary}\r\n`);
        res.write(
          `Content-Type: multipart/digest; boundary="${digestBoundary}"`,
        );
        res.write("\r\n");
        res.write(`\r\n--${digestBoundary}\r\n`);
      }

      if (is_firefox) {
        res.write("\r\n".repeat(240));
      }

      /**
       * Writes the notification to the response.
       * (If the response is being sent to Firefox, it adds multiple line breaks
       * to prevent Firefox from closing the connection prematurely.)
       */
      function writeNotification(notification, last) {
        // Content-* header will go in this line in the future
        // when deviation cases when supported
        res.write(notification);
        !last && res.write(`\r\n--${digestBoundary}\r\n`);
        if (is_firefox) {
          res.write("\r\n".repeat(240));
        }
      }

      /**
       * Writes the end of the response.
       * It writes the closing boundary for the notifications body
       * and ends the response.
       */
      function writeEnd() {
        res.write(`\r\n--${digestBoundary}--`);
        mixedBoundary && res.write(`\r\n--${mixedBoundary}--`);
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

      return eventFields;
    }

    /**
     * The `triggerNotification` function allows the middleware consumer to
     * initiate a notification.
     */
    function triggerNotification({
      path = req.path,
      generateNotification = () => rfc822Template({ res }),
    } = {}) {
      const lastEvent = method === "DELETE";
      process.nextTick(() =>
        notify({
          path,
          generateNotification,
          lastEvent,
        }),
      );
    }

    res.prep = {
      init: initializePerResourceEvents,
      send: sendResponseWithNotification,
      trigger: triggerNotification,
    };

    return next && next();
  }

  return prepMiddleware;
}

export default PREP;
