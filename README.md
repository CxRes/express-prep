# Express-PREP

A Connect/Express style middleware to send [Per Resource Events](https://cxres.github.io/prep/draft-gupta-httpbis-per-resource-events.html).

## Installation

Install **Express-PREP** and **Express-Accept-Events** using your favourite package manager.

```sh
npm|pnpm|yarn add express-prep express-accept-events
```

## Usage

We are going to describe here a non-trivial implementation of Express-PREP that produces notifications with deltas.

### Setup

```js
// Process the Accept-Events header
import AcceptEvents from "express-accept-events";
// PREP Middleware Factory
import PREP from "express-prep";
// EventID is optional but recommended
import eventID from "express-prep/event-id";
// For Custom Content Negotiation Logic
import * as negotiate from "express-prep/negotiate";
// Notification templates (or BYO)
import * as templates from "express-prep/templates";
```

**[Express-Accept-Events](https://github.com/CxRes/express-accept-events)** provides a factory function to create a middleware to parse the `Accept-Events` header field. The factory can be configured to specify if a notification protocol is supported by the server on a given URL path.

```js
const acceptEvents = AcceptEvents({
  // true, if a particular protocol is supported on a URL path
  protocols(protocol /*, url*/) {
    return protocol === "prep";
  },
  // true, if URL path supports notifications
  urls(/*url*/) {
    return true;
  },
});
```

The PREP Factory creates a middleware that provides all the functionality needed to generate and serve notifications.

```js
const prep = PREP({
  // Set the accept-events response header for a given path.
  // If unspecified, it returns `accept=message/rfc822`.
  // Also used to negotiate events by default.
  supportedEvents(/* path */) {
    // As in `prep;accept=("message/rfc822";delta="text/plain")`
    return `accept=("message/rfc822";delta="text/plain")`;
  },

  // Overrides the `Content-*` event fields computed by default,
  // Useful for setting notification media-type specific parameters.
  negotiateEvents(requestFields, allowedFields) {
    // Calculate default `Content-*`.
    // Parameter mismaches/nested parameters are put on a second Map
    // so that a consumer can match them as they see fit
    const defaultEvents = negotiate.content(requestFields,  allowedFields);

    // If the content-type itself did not match,
    // return void to fail match.
    if (!defaultEvents) { return; }

    // Since `message/rfc822` format supports delta in our implementation
    // Set the `Content-Type` for the delta
    const contentType = defaultEvents["content-type"];
    if (
      contentType[0].toString() === "message/rfc822" &&
      contentType.length > 2
    ) {
      // Check the second Map for requested delta parameter
      if (contentType[2].has('delta')) {
        // Negotiate Media-Type for delta
        const match = negotiate.type(
          contentType[2].get('delta'),
          contentType[1].get('delta'),
        );
        if (match) {
          // Set the matched format as the delta parameter
          contentType[1].set('delta', match);
        }
        else {
          // If no match, delete the delta parameter
          contentType[1].delete('delta');
        }
      }
    // Remove the mismatch
    contentType.length = 2;
    return defaultEvents;
    }
  },

  // Set `Content-*` on the `Events` header field.
  setEvents(negotiatedEvents) {
    // We do not set anything here because
    // we are setting `Content-*` for each notification instead
    return {};
  },
});
```

### Invocation

Now you are ready to invoke the middleware in your server. In case one is using an Express server:

```js
const app = express();

app.use(acceptEvents, eventID, prep);
```

The Event ID middleware populates the response with a `lastEventID` property and a `setEventID` method. Using this middleware is optional but recommended.

The PREP middleware populates the response object with a `prep` object that provide two methods `res.prep.send` and `res.prep.trigger`.

### Sending Notifications

We used the `Accept-Events` middleware to already parse the `Accept-Events`` header field.

First check if you can send notifications using `res.prep.init`. This returns an events object with the status indicating if notifications may be sent or not.

To send notifications call `res.prep.send` in your `GET` handler:

```js
app.get("/foo", (req, res) => {
  // Get the response body first
  const responseBody = obtainContent(req.url);
  // Get the content-* headers
  const contentHeaders = getMediaType(responseBody);

  let status, events, params;

  if (req.acceptEvents) {
    // There might be multiple prep entries, we try each in order, until one succeeds
    status = req.acceptEvents
      .filter(([protocol]) => protocol.toLowerCase() === "prep")
      .some(([, prepParams]) => {
        params = prepParams;
        events = res.prep.init({params});
        return events.status < 300;
      });
  }

  // if notifications were tried
  if (typeof events === 'object') {
    res.setHeader('Events', serializeDictionary(events));
  }
  // If notifications are not sent, send regular response
  if (status) {
    res.prep.send({
      events,
      body: responseBody,
      headers: contentHeaders,
      params,
    });
  }
  else {
    res.setHeaders(new Headers(headers));
    res.write(responseBody);
    res.end();
  }
});
```

### Triggering Notifications

Now you can trigger notification using `res.prep.trigger`, when the resource is modified, for example, in your `PATCH` handler.

```js
app.patch("/foo", bodyParser.text(), (req, res) => {
  let patchSuccess = false;

  // ...handle the PATCH request

  // notification is triggered if response is successful
  if (patchSuccess) {
    // set success response for notifications
    res.statusCode = 200;
    // set eventID, if you support it
    res.setHeader("Event-ID", res.setEventID());
    // close the response first
    res.end();

    // Define a function that generate the notification to send
    const generateNotification = function ({
      // which can be specific to the URL path and
      path,
      // parsed content-* event fields (see npm:structured-headers for format)
      negotiatedFields,
    }) {
      // Generate header
      const header = templates.header(negotiatedFields);

      // Check if delta is requested with the template
      let ifDiff;
      if (negotiatedFields["content-type"]?.[0] === "message/rfc822") {
        const params = negotiatedFields["content-type"][1];
        ifDiff = params.get("delta")?.[0].toString() === "text/plain";
      }

      // Generate header
      const body = templates.rfc822({
        res,
        // diff from the last response/notification (optional)
        delta: ifDiff && req.body,
      });

      // Return the notification
      return `${header}\r\n${body}`;
    };

    // Trigger the notification
    res.prep.trigger({
      // path: req.path,    // where to trigger notification (use if another path)
      generateNotification, // function for notification to send, defined above
    });
  }
});
```

## Copyright and License

(c) 2024, [Rahul Gupta](https://cxres.pages.dev/profile#i)

The source code in this repository is released under the [Mozilla Public License v2.0](./LICENSE).
