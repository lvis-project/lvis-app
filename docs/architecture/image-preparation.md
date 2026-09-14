# Image preparation

`view_image` reads an authorized local file and returns a validated visual copy.
It accepts PNG, JPEG, GIF and WebP input. Other formats require conversion by an
available image conversion tool; changing the filename extension is insufficient.
Source files are never modified. The result is PNG, preserves transparency,
corrects orientation, and contains the first frame of an animated source.

Callers can lower `maxBytes` and `maxDimension` to recover from an active
transport's image delivery error. These options cannot raise host ceilings.
The transport still owns attachment count, aggregate bytes and request
projection. Image preparation neither selects conversation history nor changes
the active provider's limits.

The [image policy](../../src/shared/image-preparation-policy.ts) owns separate
source-byte, source-pixel/channel, output-byte/dimension, execution and queue
ceilings. The [timeout policy](../../src/shared/tool-timeout-policy.ts) owns the
total deadline. Source reading uses one opened regular-file handle and checks
actual bytes as well as its initial size, so growth after the size check cannot
cause an unbounded read. Unsupported format errors are distinct from source
size errors. A smaller output request cannot make an oversized source eligible.

Only admitted jobs read source data. The host sends the authorized source path
and a copied read scope to a managed child, which repeats the existing file
policy before opening the source. Source reading and decoding both run in
that child, so a stalled read cannot hold the host's execution slot after child
termination. The existing permission and path-resolution gates remain outside
this processing deadline. Metadata gates
precede full decoding and encoding. A finite sequence of smaller dimensions
fits the output budget; even a one-pixel result may fail an unrealistically
small byte request. Returned metadata reports original and output dimensions,
frame selection, orientation correction and resizing. These facts let callers
interpret the returned image without assuming source coordinates are unchanged.

The deadline includes admission, reading and child processing. Cancellation
kills the managed child and waits for closure before releasing admission or
publishing the interrupted tool result. Decoder startup, invalid image and
output-limit failures remain visible errors; there is no in-process retry.

Pixel and concurrency ceilings limit admitted work. They are not a hard RSS
limit: higher bit depths, decoder intermediates, encoded buffers and native
allocations require additional memory. The output-byte ceiling limits returned
image data, not every allocation inside the encoder. An operating-system
resource envelope is required for a strict process memory limit.

The decoder is a separate main-bundle entry and belongs to the headless
manifest's child closure. Its runtime dependency and platform codec packages
remain external and physically unpacked. Packaging checks require the selected
target's files. The standalone runtime smoke executes the packaged child,
decodes its output, checks reported dimensions and bytes, and verifies native
dependency paths belong to the artifact.
