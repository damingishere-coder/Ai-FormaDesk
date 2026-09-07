import Foundation
import Vision
import CoreImage
import ImageIO
import UniformTypeIdentifiers

// Trusted local preprocessing worker. It never starts processes or uses the network.
// Usage: foreground input.png output-directory
enum ForegroundError: Error { case input, empty, encoding }

func savePNG(_ image: CGImage, to url: URL) throws {
    guard let destination = CGImageDestinationCreateWithURL(url as CFURL, UTType.png.identifier as CFString, 1, nil) else {
        throw ForegroundError.encoding
    }
    CGImageDestinationAddImage(destination, image, nil)
    guard CGImageDestinationFinalize(destination) else { throw ForegroundError.encoding }
}

do {
    guard CommandLine.arguments.count == 3 else { throw ForegroundError.input }
    let input = URL(fileURLWithPath: CommandLine.arguments[1])
    let output = URL(fileURLWithPath: CommandLine.arguments[2], isDirectory: true)
    try FileManager.default.createDirectory(at: output, withIntermediateDirectories: true)
    let request = VNGenerateForegroundInstanceMaskRequest()
    let handler = VNImageRequestHandler(url: input)
    try handler.perform([request])
    guard let result = request.results?.first, !result.allInstances.isEmpty else { throw ForegroundError.empty }
    let context = CIContext(options: [.cacheIntermediates: false])
    var instances: [[String: Any]] = []
    for instance in result.allInstances.prefix(8) {
        let ids = IndexSet(integer: instance)
        let masked = try result.generateMaskedImage(ofInstances: ids, from: handler, croppedToInstancesExtent: false)
        let mask = try result.generateScaledMaskForImage(forInstances: ids, from: handler)
        let foreground = CIImage(cvPixelBuffer: masked)
        let maskImage = CIImage(cvPixelBuffer: mask)
        guard let fg = context.createCGImage(foreground, from: foreground.extent),
              let alpha = context.createCGImage(maskImage, from: maskImage.extent) else { throw ForegroundError.encoding }
        let name = "foreground-\(instance).png", maskName = "mask-\(instance).png"
        try savePNG(fg, to: output.appendingPathComponent(name))
        try savePNG(alpha, to: output.appendingPathComponent(maskName))
        instances.append(["instance": instance, "foreground": name, "mask": maskName,
                          "width": fg.width, "height": fg.height])
    }
    let data = try JSONSerialization.data(withJSONObject: ["instances": instances], options: [.sortedKeys])
    print(String(decoding: data, as: UTF8.self))
} catch {
    let data = try! JSONSerialization.data(withJSONObject: ["error": String(describing: error)])
    print(String(decoding: data, as: UTF8.self))
    exit(1)
}
