# Test fixtures

Drop a short English `.wav` here named `sample-en.wav`. Any clean 16-bit/16 kHz mono clip works for the smoke test.

Generate one quickly with `ffmpeg`:

```sh
ffmpeg -f lavfi -i "sine=frequency=440:duration=3" -ar 16000 -ac 1 tests/fixtures/sample-en.wav
```

For a real keyword test, record a short phrase ("Hello, this is a whisper test") at 16 kHz mono with any recorder.
