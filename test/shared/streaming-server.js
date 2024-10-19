/*!
 *  Copyright (c) 2024, Rahul Gupta and Express PREP contributors.
 *
 *  This Source Code Form is subject to the terms of the Mozilla Public
 *  License, v. 2.0. If a copy of the MPL was not distributed with this
 *  file, You can obtain one at http://mozilla.org/MPL/2.0/.
 *
 *  SPDX-License-Identifier: MPL-2.0
 */
import { createServer } from "node:http";
import { createReadStream } from "node:fs";
import acceptEvents from "express-accept-events";
import prep from "../../src/prep.js";
import eventID from "../../src/event-id.js";

const SUPPORTED_EVENTS = `accept=("message/rfc822")`;

function requestListener(req, res) {
  acceptEvents(req, res);
  eventID(req, res);
  prep(req, res);

  switch (req.method) {
    case "GET": {
      const responseBody = createReadStream("./test/shared/dummy.txt");
      const headers = {
        "Content-Type": "text/plain",
      };

      // By default this function configures notifications to be sent as `message/rfc822`.
      let failStatus = res.events.prep.configure(SUPPORTED_EVENTS);

      // Fail quickly if server is misconfigured
      if (!failStatus) {
        // Iterate to the first PREP notifications request
        for (const [protocol, params] of req.acceptEvents || []) {
          if (protocol === "prep") {
            const eventsStatus = res.events.prep.send({
              isBodyStream: true,
              body: responseBody,
              headers,
              params,
            });

            // if notifications are sent, you can quit
            if (!eventsStatus) return;

            // Record the first failure only
            if (!failStatus) {
              failStatus = eventsStatus;
            }
          }
        }
      }

      // If notifications are not sent, send regular response
      if (failStatus) {
        // Serialize failed events as header
        // headers.events = serializeDictionary(failStatus);
        headers.events = failStatus;
      }
      res.setHeaders(new Headers(headers));
      responseBody.pipe(res.write);
      res.end();
      return;
    }
    case "PUT":
    case "POST":
    case "PATCH":
    case "DELETE":
      res.statusCode = 200;
      res.setHeader("Event-ID", res.setEventID());
      res.end();
      res.events.prep.trigger();
  }
}

const server = createServer(requestListener);

export default server;
