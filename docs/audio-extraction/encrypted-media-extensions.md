             YOUR WEBSITE
                  │
               EME API 
                  |
                  ▼
             Chrome
                  │
                  ▼
          Widevine CDM
                  │
          license request
                  │
                  ▼
          YOUR LICENSE SERVER
                  │
             license
                  │
                  ▼
          Widevine CDM
                  │
               decrypt
                  │
                  ▼
          encrypted.mp4
                  │
                  ▼
               video


## Example setup for EME: 

```
<!doctype html>
<html>
<body>
  <video id="video" controls></video>
  <script src="player.js"></script>
</body>
</html>
```


player.js: 
```
const video = document.getElementById("video");

const config = [{
  initDataTypes: ["cenc"],
  videoCapabilities: [{
    contentType: 'video/mp4; codecs="avc1.640028"',
    encryptionScheme: "cenc"
  }]
}];

// 1. Ask Chrome for Widevine
const access =
  await navigator.requestMediaKeySystemAccess(
    "com.widevine.alpha",
    config
  );

// 2. Create the Widevine MediaKeys object
// MediaKeys gives you methods like createSession() and setServerCertificate()
const mediaKeys = await access.createMediaKeys();

// 3. Give the video element those keys
await video.setMediaKeys(mediaKeys);

// 4. When the encrypted video triggers an encrypted event...
video.addEventListener("encrypted", async (event) => {

  // Create a session with Widevine
  // `createSession` handles the license exchange
  const session = mediaKeys.createSession();

  // Widevine generates a license request
  session.addEventListener("message", async (event) => {

    // Send this to YOUR license server
    // This is part that requires actual setup. 
    // Your server needs to understand the Widevine license protocol 
    // and return a license that the Widevine CDM accepts.
    const response = await fetch("/license", {
      method: "POST",
      body: event.message
    });

    const license = await response.arrayBuffer();

    // Give the license back to Widevine
    await session.update(license);
  });

  await session.generateRequest(
    event.initDataType,
    event.initData
  );
});

// 5. Give the video an encrypted media URL
video.src = "/video/encrypted.mp4";

```
