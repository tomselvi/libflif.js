// This should later be a Web Worker, currently this is just a normal script

importScripts("libflif.js");
let notifyReady: () => void;
const whenReady = new Promise<void>(resolve => notifyReady = resolve);
const libflifem = _libflifem({
    onRuntimeInitialized: notifyReady
});

declare class SharedArrayBuffer extends ArrayBuffer {

}

interface libflifWorkerInputMessageEvent extends MessageEvent {
    data: libflifWorkerInputMessageData;
}

self.addEventListener("message", async (ev: libflifWorkerInputMessageEvent) => {
    await whenReady;
    (self as any as Worker).postMessage({
        debug: `received data for ${ev.data.type}. Current memory size: ${libflifem.buffer.byteLength}`
    });
    try {
        if (ev.data.type === "decode") {
            decode(ev.data.uuid, ev.data.input);

            // (self as any as Worker).postMessage({
            //     debug: `decode complete, sending data to wrapper.`
            // });
            // (self as any as Worker).postMessage({
            //     uuid: ev.data.uuid,
            //     result
            // });
        }
        else {
            const result = encode(ev.data.input);
            (self as any as Worker).postMessage({
                debug: `encode complete, sending data to wrapper. Current memory size: ${libflifem.buffer.byteLength}`
            });
            (self as any as Worker).postMessage({
                uuid: ev.data.uuid,
                result
            });
        }
    }
    catch (err) {
        (self as any as Worker).postMessage({ uuid: ev.data.uuid, error: err.stack || err.message || "Unspecified error occurred" });
    }
})

function decode(uuid: string, input: libflifDecoderInput) {
    const step = (input.options && input.options.progressiveStep) || 5000;
    let lastPreviewTime = 0;

    const decoder = new libflifem.FLIFDecoder();
    const callback = libflifem.Runtime.addFunction((quality: number, bytesReadLow: number, bytesReadHigh: number, decode_over: number, user_data: number, context: number) => {
        const now = Date.now();
        if (quality !== 10000 && now - lastPreviewTime < 600) {
            return quality + step;
        }
        lastPreviewTime = now;

        decoder.generatePreview(context);

        const frames: libflifFrame[] = [];
        for (let i = 0; i < decoder.numImages; i++) {
            const frame = decoder.getImage(i);
            // TODO: replace ArrayBuffer to SharedArrayBuffer
            // (currently impossible on Nightly because of structured clone error
            const bufferView = new Uint8Array(new ArrayBuffer(frame.width * frame.height * 4));
            for (let i = 0; i < frame.height; i++) {
                const row = frame.readRowRGBA8(i);
                const offset = frame.width * 4 * i;
                bufferView.set(row, offset);
                frame.clearBuffer(); // remove C++ internal buffer created by readRow
            }
            frames.push({
                data: bufferView.buffer,
                width: frame.width,
                height: frame.height,
                frameDelay: frame.frameDelay,
            });
            frame.delete(); // will not affect decoder internal image instance 
        }

        const bytesRead = bytesReadLow + bytesReadHigh << 32;
        const progress: libflifProgressiveDecodingResult = {
            quality,
            bytesRead,
            frames,
            loop: decoder.numLoops
        };

        (self as any as Worker).postMessage({
            uuid,
            progress,
            debug: `progressive decoding: width=${frames[0].width} height=${frames[0].height} quality=${quality}, bytesRead=${bytesRead}. Current memory size: ${libflifem.buffer.byteLength}`
        });
        return quality + step;
    });
    decoder.setCallback(callback);
    if (input.options) {
        setDecoderOptions(decoder, input.options);
    }

    const allocated = libflifem._malloc(input.data.byteLength);
    libflifem.HEAP8.set(new Uint8Array(input.data), allocated);
    try {
        decoder.decodeMemory(allocated, input.data.byteLength);
    }
    finally {
        libflifem._free(allocated);
        decoder.delete();
        libflifem.Runtime.removeFunction(callback);
    }
}

function setDecoderOptions(decoder: FLIFDecoder, options: libflifDecoderOptions) {
    if ("crcCheck" in options) {
        decoder.setCRCCheck(options.crcCheck);
    }
    if (options.fit instanceof Array) {
        decoder.setFit(options.fit[0], options.fit[1]);
    }
    if ("quality" in options) {
        decoder.setQuality(options.quality);
    }
    if (options.resize instanceof Array) {
        decoder.setResize(options.resize[0], options.resize[1]);
    }
    if ("scale" in options) {
        decoder.setScale(options.scale);
    }
    if ("progressiveInitialLimit" in options) {
        decoder.setFirstCallbackQuality(options.progressiveInitialLimit)
    }
}

function encode(input: libflifEncoderInput) {
    const encoder = new libflifem.FLIFEncoder();
    const images: FLIFImage[] = [];
    for (let frame of input.frames) {
        const depth = frame.depth || 8;
        const multiplier = depth / 8;
        const image = (depth === 16 ? libflifem.FLIFImage.createHDR : libflifem.FLIFImage.create)(frame.width, frame.height);
        const bufferView = new (depth === 16 ? Uint16Array : Uint8Array)(frame.data);
        const size = frame.width * 3;
        for (let i = 0; i < frame.height; i++) {
            const offset = size * i;
            const allocated = libflifem._malloc(size * multiplier);
            libflifem.HEAP8.set(new Uint8Array(bufferView.slice(offset, offset + size).buffer), allocated);
            if (depth === 16) {
                image.writeRowRGBA16(i, allocated, size * multiplier);
            }
            else {
                image.writeRowRGB8(i, allocated, size * multiplier);
            }
            libflifem._free(allocated);
        }
        if ("frameDelay" in frame) {
            image.frameDelay = frame.frameDelay;
        }

        encoder.addImage(image);
        images.push(image);
    }

    if (input.options) {
        setEncoderOptions(encoder, input.options);
    }

    let result: ArrayBuffer;
    try {
        const encodeView = encoder.encodeToMemory();
        result = encodeView.buffer.slice(encodeView.byteOffset, encodeView.byteOffset + encodeView.byteLength);
    }
    finally {
        for (let image of images) {
            image.delete();
        }
        encoder.delete();
    }
    return result;
}

function setEncoderOptions(encoder: FLIFEncoder, options: libflifEncoderOptions) {
    if (options.alphaZeroLossless) {
        encoder.setAlphaZeroLossless();
    }
    if ("autoColorBuckets" in options) {
        encoder.setAutoColorBuckets(options.autoColorBuckets);
    }
    if ("chanceAlpha" in options) {
        encoder.setChanceAlpha(options.chanceAlpha);
    }
    if ("chanceCutoff" in options) {
        encoder.setChanceCutoff(options.chanceCutoff);
    }
    if ("crcCheck" in options) {
        encoder.setCRCCheck(options.crcCheck);
    }
    if ("divisor" in options) {
        encoder.setDivisor(options.divisor);
    }
    if ("frameShape" in options) {
        encoder.setFrameShape(options.frameShape);
    }
    if ("interlaced" in options) {
        encoder.setInterlaced(options.interlaced);
    }
    if ("learnRepeat" in options) {
        encoder.setLearnRepeat(options.learnRepeat);
    }
    if ("lookback" in options) {
        encoder.setLookback(options.lookback);
    }
    if ("minSize" in options) {
        encoder.setMinSize(options.minSize);
    }
    if ("paletteSize" in options) {
        encoder.setPaletteSize(options.paletteSize);
    }
    if ("splitThreshold" in options) {
        encoder.setSplitThreshold(options.splitThreshold);
    }
    if ("yCoCg" in options) {
        encoder.setYCoCg(options.yCoCg);
    }
}

namespace EmscriptenUtility {
    export interface AllocatedArray {
        content: any[];
        pointer: number;
    }

    export function allocateString(em: EmscriptenModule, input: string) {
        var array = em.intArrayFromString(input, false);
        var pointer = em._malloc(array.length);
        em.HEAP8.set(new Int8Array(array), pointer);
        return pointer;
    }

    export function allocateStringArray(em: EmscriptenModule, input: string[]) {
        var array: number[] = [];
        input.forEach(item => array.push(allocateString(em, item)));
        var pointer = em._malloc(array.length * 4);
        em.HEAP32.set(new Int32Array(array), pointer / 4);
        return <AllocatedArray>{
            content: array,
            pointer: pointer
        };
    }

    export function deleteStringArray(em: EmscriptenModule, input: AllocatedArray) {
        input.content.forEach((item) => em._free(item));
        em._free(input.pointer);
    }
}
