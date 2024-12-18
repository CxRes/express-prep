# Express PREP

A Connect/Express style middleware to send [Per Resource Events](https://cxres.github.io/prep/draft-gupta-httpbis-per-resource-events.html).

## Installation

Install **Express PREP** and **Express Accept Events** using your favourite package manager.

```sh
npm|pnpm|yarn add express-prep express-accept-events
```

## Usage

_Consider using the **[Express Negotiate Events](https://www.npmjs.com/package/express-negotiate-events)** package instead for a simplified notifications setup._

We are going to describe here a non-trivial implementation of **Express PREP** to serve notifications with deltas.

### Setup

Add the following imports to your server:

```js
// Process the Accept-Events header
import acceptEvents from "express-accept-events";
// PREP Middleware Factory
import prep from "express-prep";
// EventID is optional but recommended
import eventID from "express-prep/event-id";
// For Custom Content Negotiation Logic
import * as negotiate from "express-prep/negotiate";
// Notification templates (or BYO)
import * as templates from "express-prep/templates";
```

### Invocation

Invoke the middleware in your server. In case one is using an Express server:

```js
const app = express();
app.use(acceptEvents, eventID, prep);
```

The Event ID middleware populates the response with a `lastEventID` property and a `setEventID` method. Using this middleware is optional but recommended.

The PREP middleware populates the response object with a `events.prep` object that provide methods to configure, send and trigger notifications.

### Sending Notifications

We used the `Accept-Events` middleware to already parse the `Accept-Events` header field. This populates `res.acceptEvents` with the notifications request headers.

First configure notifications using `res.events.prep.configure()` in the `GET` handler.

To send notifications call `res.events.prep.send()` in your `GET` handler:

```js
app.get("/foo", (req, res) => {
  // Get the response body first
  const body = getContent(req.url);
  // Get the content-* headers
  const headers = getMediaType(responseBody);

  // Configures notifications to be sent as `message/rfc822` with deltas.
  // The default is to omit the delta.
  let failStatus = res.events.prep.configure(
    `accept=("message/rfc822"; delta="text/plain")`,
  );

  // Custom logic for negotiating media-type for deltas
  // The headers are parsed "npm:structured-headers". PREP adds a second
  // Map after parameters to List Item with requested deltas, allowing
  // an implementor to negotiate against the configured parameters.
  function negotiateEvents(defaultEvents) {
    const cType = defaultEvents["content-type"];
    if (cType[0].toString() === "message/rfc822" && cType.length > 2) {
      // Check for additional map after parameters for the
      // "message/rfc822" item
      if (cType[2].has("delta")) {
        // Manually negotiate Media-Type for delta
        const match = negotiate.type(
          cType[2].get("delta"),
          cType[1].get("delta"),
        );
        if (match) {
          // If match, set the matched format as the delta parameter
          cType[1].set("delta", match);
        } else {
          // If no match, delete the delta parameter
          cType[1].delete("delta");
        }
      }
      // Second Map is automatically removed
      return defaultEvents;
    }
  }

  // Fail quickly if server is misconfigured
  if (!failStatus) {
    // Iterate to the first PREP notifications request
    for (const [protocol, params] of req.acceptEvents || []) {
      if (protocol === "prep") {
        const eventsStatus = res.events.prep.send({
          body, // can also be a stream
          headers,
          params,
          modifiers: {
            negotiateEvents,
          },
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
    headers.events = serializeDictionary(failStatus);
  }
  res.setHeaders(new Headers(headers));
  res.write(responseBody);
  res.end();
});
```

### Triggering Notifications

Now you can trigger a notification using `res.events.prep.trigger()`, when the resource is modified, for example, in your `PATCH` handler.

```js
app.patch("/foo", bodyParser.text(), (req, res, next) => {
  let patchSuccess = false;

  // ...handle the PATCH request

  // notification is triggered if response is successful
  if (patchSuccess) {
    // set success response for notifications
    res.statusCode = 200;
    // set eventID, if you support it
    res.setHeader("Event-ID", res.setEventID());
    // you can set eventID on other paths, say, in case of side effects
    //   res.setEventID("/another/path")
    // you also set your own eventID for a given path
    //   res.setEventID({ path: req.path, id:"foo" })
    // close the response first
    res.end();

    // IMPORTANT: Go to the next middleware when request succeeds to trigger the notification
    return next && next();
  }
});

app.patch("/foo", bodyParser.text(), (req, res) => {
  // Define a function that generates the notification to send
  function generateNotification(
    negotiatedFields,
    // which can be specific to the parsed content-* event fields
    // for a given path specified in the trigger function
    // (see npm:structured-headers for format)
  ) {
    // Generate part header from template
    const header = templates.header(negotiatedFields);

    // Check if delta is requested with the template
    let ifDiff;
    if (negotiatedFields["content-type"]?.[0] === "message/rfc822") {
      const params = negotiatedFields["content-type"][1];
      ifDiff = params.get("delta")?.[0].toString() === "text/plain";
    }

    // Generate part body from a template
    const body = templates.rfc822({
      date: res._header.match(/^Date: (.*?)$/m)?.[1],
      method: req.method,
      eventID: res.getHeader("event-id"), // (optional, but recommended)
      // location: res.getHeader("Location"), // (optional)
      // diff from the last response
      delta: ifDiff && req.body, // (optional)
    });

    // Return the notification
    return `${header}\r\n${body}`;
  }

  // Trigger the notification
  res.events.prep.trigger({
    // path               // where to trigger notification
    // (default: req.path)
    generateNotification, // function for notification to send, defined above
    // (default: message/rfc822 notifications with only headers)
    // lastEvent          // Set to true to close stream after this notification
    // (default: false)
  });
});
```

#### Default Template

The `generateNotification()` function when not specified at the time of triggering notification results in a default `message/rfc822` format notification being generated.

This default notification is also exposed as `res.events.prep.defaultNotification()`. Users may use this function to modify default values rather than calling the template:

```js
  res.events.prep.trigger({
    generateNotification(negotiatedFields) {
      // ... determine if the diff exists as before
      return res.events.prep.defaultNotification({
        delta: ifDiff && req.body
      }),
    },
  });
```

## Copyright and License

(c) 2024, [Rahul Gupta](https://cxres.pages.dev/profile#i) and Express PREP contributors.

The source code in this repository is released under the [Mozilla Public License v2.0](./LICENSE).
