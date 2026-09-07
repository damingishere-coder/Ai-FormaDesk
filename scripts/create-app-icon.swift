import AppKit

// A native macOS rendition of public/favicon.svg; no external image assets.
let directory = URL(fileURLWithPath: CommandLine.arguments[1])
for size in [16, 32, 128, 256, 512] {
    for scale in [1, 2] {
        let pixels = size * scale
        let bitmap = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: pixels,
            pixelsHigh: pixels, bitsPerSample: 8, samplesPerPixel: 4,
            hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB,
            bytesPerRow: 0, bitsPerPixel: 0)!
        NSGraphicsContext.saveGraphicsState()
        NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: bitmap)
        let factor = CGFloat(pixels) / 1024
        let transform = AffineTransform(scale: factor)
        (transform as NSAffineTransform).concat()
        NSColor(calibratedRed: 0.97, green: 0.97, blue: 0.955, alpha: 1).setFill()
        NSBezierPath(roundedRect: NSRect(x: 72, y: 72, width: 880, height: 880),
            xRadius: 198, yRadius: 198).fill()
        NSColor(calibratedRed: 0.204, green: 0.275, blue: 0.196, alpha: 1).setStroke()
        let path = NSBezierPath()
        path.lineWidth = 38
        path.lineJoinStyle = .round
        path.lineCapStyle = .round
        path.move(to: NSPoint(x: 512, y: 812))
        for point in [NSPoint(x: 772, y: 660), NSPoint(x: 772, y: 364),
                      NSPoint(x: 512, y: 212), NSPoint(x: 252, y: 364),
                      NSPoint(x: 252, y: 660)] { path.line(to: point) }
        path.close()
        path.move(to: NSPoint(x: 252, y: 660))
        path.line(to: NSPoint(x: 512, y: 508))
        path.line(to: NSPoint(x: 772, y: 660))
        path.move(to: NSPoint(x: 512, y: 508))
        path.line(to: NSPoint(x: 512, y: 212))
        path.move(to: NSPoint(x: 382, y: 736))
        path.line(to: NSPoint(x: 642, y: 584))
        path.stroke()
        NSGraphicsContext.restoreGraphicsState()
        let suffix = scale == 2 ? "@2x" : ""
        let output = directory.appendingPathComponent("icon_\(size)x\(size)\(suffix).png")
        try bitmap.representation(using: .png, properties: [:])!.write(to: output)
    }
}
