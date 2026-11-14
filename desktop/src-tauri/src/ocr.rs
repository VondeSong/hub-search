use std::path::Path;
#[cfg(any(windows, test))]
mod control;
#[cfg(windows)]
mod native;
#[cfg(any(windows, test))]
mod pool;
#[cfg(windows)]
mod process;
#[cfg(windows)]
mod worker;

#[cfg(windows)]
use windows::{
    core::{Interface, HSTRING},
    Data::Pdf::{PdfDocument, PdfPageRenderOptions},
    Graphics::Imaging::{
        BitmapAlphaMode, BitmapDecoder, BitmapPixelFormat, BitmapTransform, ColorManagementMode,
        ExifOrientationMode, SoftwareBitmap,
    },
    Media::Ocr::OcrEngine,
    Storage::Streams::{DataReader, IRandomAccessStream, InMemoryRandomAccessStream},
    Storage::{FileAccessMode, StorageFile},
};

#[cfg(windows)]
fn windows_error(context: &str, error: windows::core::Error) -> String {
    format!("{context}：{error}")
}

#[cfg(windows)]
fn winrt_storage_path(path: &Path) -> Result<HSTRING, String> {
    use std::os::windows::ffi::OsStrExt;

    // fs::canonicalize produces a Win32 verbatim path. StorageFile expects an
    // ordinary absolute drive/UNC path; retain UTF-16 rather than round-tripping
    // through a lossy string. This does not add general long-path support.
    let wide: Vec<u16> = path.as_os_str().encode_wide().collect();
    let unsupported =
        || "OCR_PATH_UNSUPPORTED: Windows OCR 不支持此文件路径命名空间或文件名".to_string();
    if wide.starts_with(&[92, 92, 46, 92]) || wide.starts_with(&[92, 63, 63, 92]) {
        return Err(unsupported());
    }
    if !wide.starts_with(&[92, 92, 63, 92]) {
        // Preserve the existing StorageFile errors for relative/ordinary paths.
        return Ok(HSTRING::from_wide(&wide));
    }

    let verbatim = &wide[4..];
    let (ordinary, names, device_name_start) = if verbatim.starts_with(&[85, 78, 67, 92]) {
        let names = &verbatim[4..];
        let mut components = names.split(|unit| *unit == 92);
        if components.next().is_none_or(|name| name.is_empty())
            || components.next().is_none_or(|name| name.is_empty())
        {
            return Err(unsupported());
        }
        let mut ordinary = vec![92, 92];
        ordinary.extend_from_slice(names);
        (ordinary, names, 2)
    } else if verbatim.len() >= 3
        && matches!(verbatim[0], 65..=90 | 97..=122)
        && verbatim[1..3] == [58, 92]
    {
        (verbatim.to_vec(), &verbatim[3..], 0)
    } else {
        return Err(unsupported());
    };
    if names.first() == Some(&92) || names.windows(2).any(|pair| pair == [92, 92]) {
        return Err(unsupported());
    }

    // Removing a verbatim prefix must not change the target. DOS normalization
    // interprets dot/space suffixes, dot segments and reserved device names.
    for (index, name) in names.split(|unit| *unit == 92).enumerate() {
        if name.is_empty() {
            continue;
        }
        if matches!(name.first(), Some(32))
            || matches!(name.last(), Some(32 | 46))
            || name
                .iter()
                .any(|unit| matches!(*unit, 0..=31 | 34 | 42 | 47 | 58 | 60 | 62 | 63 | 124))
        {
            return Err(unsupported());
        }
        let mut base = name.split(|unit| *unit == 46).next().unwrap();
        while base.last() == Some(&32) {
            base = &base[..base.len() - 1];
        }
        // UNC server/share labels are not DOS file components.
        if index >= device_name_start && base.len() <= 7 {
            let upper: Vec<u16> = base
                .iter()
                .map(|unit| match unit {
                    97..=122 => unit - 32,
                    _ => *unit,
                })
                .collect();
            let reserved = ["CON", "PRN", "AUX", "NUL", "CONIN$", "CONOUT$", "CLOCK$"]
                .iter()
                .any(|reserved| upper.iter().copied().eq(reserved.encode_utf16()))
                || (upper.len() == 4
                    && matches!(&upper[..3], [67, 79, 77] | [76, 80, 84])
                    && matches!(upper[3], 49..=57 | 178 | 179 | 185));
            if reserved {
                return Err(unsupported());
            }
        }
    }
    Ok(HSTRING::from_wide(&ordinary))
}

#[cfg(windows)]
fn storage_file(path: &Path) -> Result<StorageFile, String> {
    let path = winrt_storage_path(path)?;
    StorageFile::GetFileFromPathAsync(&path)
        .map_err(|error| windows_error("无法打开 OCR 文件", error))?
        .get()
        .map_err(|error| windows_error("无法读取 OCR 文件", error))
}

#[cfg(windows)]
fn ocr_engine() -> Result<OcrEngine, String> {
    OcrEngine::TryCreateFromUserProfileLanguages()
        .map_err(|error| windows_error("无法初始化 Windows OCR", error))
}

#[cfg(windows)]
fn decode_bitmap(stream: &IRandomAccessStream) -> Result<SoftwareBitmap, String> {
    stream
        .Seek(0)
        .map_err(|error| windows_error("无法定位图片数据流", error))?;
    let decoder = BitmapDecoder::CreateAsync(stream)
        .map_err(|error| windows_error("无法创建图片解码器", error))?
        .get()
        .map_err(|error| windows_error("无法解码图片", error))?;
    let width = decoder
        .OrientedPixelWidth()
        .map_err(|error| windows_error("无法读取图片宽度", error))?;
    let height = decoder
        .OrientedPixelHeight()
        .map_err(|error| windows_error("无法读取图片高度", error))?;
    let maximum = OcrEngine::MaxImageDimension()
        .map_err(|error| windows_error("无法读取 OCR 图片尺寸限制", error))?;
    if width <= maximum && height <= maximum {
        return decoder
            .GetSoftwareBitmapAsync()
            .map_err(|error| windows_error("无法创建 OCR 位图", error))?
            .get()
            .map_err(|error| windows_error("无法读取 OCR 位图", error));
    }

    let scale = (maximum as f64 / width.max(height) as f64).min(1.0);
    let transform =
        BitmapTransform::new().map_err(|error| windows_error("无法创建图片缩放器", error))?;
    transform
        .SetScaledWidth(((width as f64 * scale).round() as u32).max(1))
        .map_err(|error| windows_error("无法设置 OCR 图片宽度", error))?;
    transform
        .SetScaledHeight(((height as f64 * scale).round() as u32).max(1))
        .map_err(|error| windows_error("无法设置 OCR 图片高度", error))?;
    decoder
        .GetSoftwareBitmapTransformedAsync(
            BitmapPixelFormat::Bgra8,
            BitmapAlphaMode::Premultiplied,
            &transform,
            ExifOrientationMode::RespectExifOrientation,
            ColorManagementMode::DoNotColorManage,
        )
        .map_err(|error| windows_error("无法缩放 OCR 图片", error))?
        .get()
        .map_err(|error| windows_error("无法读取缩放后的 OCR 图片", error))
}

#[cfg(windows)]
fn recognize_bitmap(engine: &OcrEngine, bitmap: SoftwareBitmap) -> Result<String, String> {
    struct BitmapGuard(SoftwareBitmap);
    impl Drop for BitmapGuard {
        fn drop(&mut self) {
            let _ = self.0.Close();
        }
    }
    let bitmap = BitmapGuard(bitmap);
    let result = engine
        .RecognizeAsync(&bitmap.0)
        .map_err(|error| windows_error("无法启动 OCR 识别", error))?
        .get()
        .map_err(|error| windows_error("OCR 识别失败", error))?
        .Text()
        .map(|text| text.to_string())
        .map_err(|error| windows_error("无法读取 OCR 文字", error));
    result
}

#[cfg(windows)]
fn recognize_image_with(engine: &OcrEngine, path: &Path) -> Result<String, String> {
    let file = storage_file(path)?;
    let stream = file
        .OpenAsync(FileAccessMode::Read)
        .map_err(|error| windows_error("无法打开图片数据流", error))?
        .get()
        .map_err(|error| windows_error("无法读取图片数据流", error))?;
    let bitmap = decode_bitmap(&stream)?;
    recognize_bitmap(engine, bitmap)
}

#[cfg(windows)]
fn recognize_pdf_document(
    engine: &OcrEngine,
    document: &PdfDocument,
    page_number: u32,
) -> Result<String, String> {
    if page_number == 0 {
        return Err("PDF OCR 页码必须从 1 开始".to_string());
    }
    let page_count = document
        .PageCount()
        .map_err(|error| windows_error("无法读取 PDF 页数", error))?;
    if page_number > page_count {
        return Err(format!("PDF OCR 页码超出范围：{page_number}/{page_count}"));
    }
    let page = document
        .GetPage(page_number - 1)
        .map_err(|error| windows_error("无法打开 PDF 页面", error))?;
    struct PageGuard(windows::Data::Pdf::PdfPage);
    impl Drop for PageGuard {
        fn drop(&mut self) {
            let _ = self.0.Close();
        }
    }
    let page = PageGuard(page);
    let page = &page.0;
    let size = page
        .Size()
        .map_err(|error| windows_error("无法读取 PDF 页面尺寸", error))?;
    let maximum = OcrEngine::MaxImageDimension()
        .map_err(|error| windows_error("无法读取 OCR 图片尺寸限制", error))?;
    let target_scale = 2.5_f32;
    let width = (size.Width * target_scale).round().max(1.0) as u32;
    let height = (size.Height * target_scale).round().max(1.0) as u32;
    let scale = (maximum as f64 / width.max(height) as f64).min(1.0);
    let options = PdfPageRenderOptions::new()
        .map_err(|error| windows_error("无法创建 PDF 渲染选项", error))?;
    options
        .SetDestinationWidth(((width as f64 * scale).round() as u32).max(1))
        .map_err(|error| windows_error("无法设置 PDF OCR 宽度", error))?;
    options
        .SetDestinationHeight(((height as f64 * scale).round() as u32).max(1))
        .map_err(|error| windows_error("无法设置 PDF OCR 高度", error))?;
    let stream = InMemoryRandomAccessStream::new()
        .map_err(|error| windows_error("无法创建 PDF 页面数据流", error))?;
    page.RenderWithOptionsToStreamAsync(&stream, &options)
        .map_err(|error| windows_error("无法渲染 PDF 页面", error))?
        .get()
        .map_err(|error| windows_error("PDF 页面渲染失败", error))?;
    stream
        .Seek(0)
        .map_err(|error| windows_error("无法定位 PDF 页面数据流", error))?;
    let random_stream: IRandomAccessStream = stream
        .cast()
        .map_err(|error| windows_error("无法读取 PDF 页面数据流", error))?;
    let bitmap = decode_bitmap(&random_stream)?;
    recognize_bitmap(engine, bitmap)
}

#[cfg(windows)]
pub fn recognize_image(path: &Path) -> Result<String, String> {
    native::execute_blocking(native::Job::Image(path.into()))
}
#[cfg(windows)]
pub fn recognize_pdf_page(path: &Path, page_number: u32) -> Result<String, String> {
    native::execute_blocking(native::Job::Pdf {
        path: path.into(),
        hash: None,
        page: page_number,
    })
}
pub(crate) async fn recognize_image_async(path: &Path) -> Result<String, String> {
    #[cfg(windows)]
    {
        native::execute(native::Job::Image(path.into())).await
    }
    #[cfg(not(windows))]
    {
        recognize_image(path)
    }
}
pub(crate) async fn recognize_image_controlled(
    path: &Path,
    operation: &crate::library_runtime::Operation,
) -> Result<String, String> {
    #[cfg(windows)]
    {
        native::execute_controlled(native::Job::Image(path.into()), operation).await
    }
    #[cfg(not(windows))]
    {
        operation.checkpoint()?;
        recognize_image(path)
    }
}
/// Caller supplies the verified immutable BlobStore identity, never path metadata.
pub(crate) async fn recognize_pdf_blob_page(
    path: &Path,
    hash: &str,
    page_number: u32,
) -> Result<String, String> {
    #[cfg(windows)]
    {
        native::execute(native::Job::Pdf {
            path: path.into(),
            hash: Some(hash.into()),
            page: page_number,
        })
        .await
    }
    #[cfg(not(windows))]
    {
        let _ = hash;
        recognize_pdf_page(path, page_number)
    }
}
pub(crate) async fn recognize_pdf_blob_page_controlled(
    path: &Path,
    hash: &str,
    page_number: u32,
    operation: &crate::library_runtime::Operation,
) -> Result<String, String> {
    #[cfg(windows)]
    {
        native::execute_controlled(
            native::Job::Pdf {
                path: path.into(),
                hash: Some(hash.into()),
                page: page_number,
            },
            operation,
        )
        .await
    }
    #[cfg(not(windows))]
    {
        let _ = hash;
        operation.checkpoint()?;
        recognize_pdf_page(path, page_number)
    }
}
pub(crate) fn run_worker_stdio() -> Result<(), String> {
    #[cfg(windows)]
    {
        worker::run_stdio()
    }
    #[cfg(not(windows))]
    {
        Err("OCR 当前仅支持 Windows".into())
    }
}
pub(crate) fn is_admission_error(error: &str) -> bool {
    error.starts_with("OCR_POOL_BUSY:") || error.starts_with("OCR_POOL_CLOSED:")
}
pub(crate) fn shutdown() {
    #[cfg(windows)]
    native::shutdown();
}

#[cfg(windows)]
pub fn render_pdf_page_png(
    path: &Path,
    page_number: u32,
    maximum_dimension: u32,
) -> Result<Vec<u8>, String> {
    if page_number == 0 {
        return Err("PDF 预览页码必须从 1 开始".to_string());
    }
    let file = storage_file(path)?;
    let document = PdfDocument::LoadFromFileAsync(&file)
        .map_err(|error| windows_error("无法打开 PDF 预览", error))?
        .get()
        .map_err(|error| windows_error("无法读取 PDF 预览", error))?;
    let page_count = document
        .PageCount()
        .map_err(|error| windows_error("无法读取 PDF 页数", error))?;
    if page_number > page_count {
        return Err(format!("PDF 预览页码超出范围：{page_number}/{page_count}"));
    }
    let page = document
        .GetPage(page_number - 1)
        .map_err(|error| windows_error("无法打开 PDF 预览页面", error))?;
    let size = page
        .Size()
        .map_err(|error| windows_error("无法读取 PDF 页面尺寸", error))?;
    let maximum_dimension = maximum_dimension.clamp(640, 2400);
    let scale = (maximum_dimension as f64 / f64::from(size.Width.max(size.Height))).min(2.0);
    let options = PdfPageRenderOptions::new()
        .map_err(|error| windows_error("无法创建 PDF 预览选项", error))?;
    options
        .SetDestinationWidth(((f64::from(size.Width) * scale).round() as u32).max(1))
        .map_err(|error| windows_error("无法设置 PDF 预览宽度", error))?;
    options
        .SetDestinationHeight(((f64::from(size.Height) * scale).round() as u32).max(1))
        .map_err(|error| windows_error("无法设置 PDF 预览高度", error))?;
    let stream = InMemoryRandomAccessStream::new()
        .map_err(|error| windows_error("无法创建 PDF 预览数据流", error))?;
    page.RenderWithOptionsToStreamAsync(&stream, &options)
        .map_err(|error| windows_error("无法渲染 PDF 预览页面", error))?
        .get()
        .map_err(|error| windows_error("PDF 预览页面渲染失败", error))?;
    let length = stream
        .Size()
        .map_err(|error| windows_error("无法读取 PDF 预览大小", error))?;
    if length > 20 * 1024 * 1024 {
        let _ = page.Close();
        return Err("PDF 单页预览超过 20 MB，已跳过页面图像".to_string());
    }
    let input = stream
        .GetInputStreamAt(0)
        .map_err(|error| windows_error("无法打开 PDF 预览数据", error))?;
    let reader = DataReader::CreateDataReader(&input)
        .map_err(|error| windows_error("无法创建 PDF 预览读取器", error))?;
    reader
        .LoadAsync(length as u32)
        .map_err(|error| windows_error("无法加载 PDF 预览数据", error))?
        .get()
        .map_err(|error| windows_error("无法读取 PDF 预览数据", error))?;
    let mut bytes = vec![0_u8; length as usize];
    reader
        .ReadBytes(&mut bytes)
        .map_err(|error| windows_error("无法复制 PDF 预览数据", error))?;
    let _ = reader.Close();
    let _ = page.Close();
    Ok(bytes)
}

#[cfg(windows)]
pub fn pdf_page_count(path: &Path) -> Result<u32, String> {
    let file = storage_file(path)?;
    let document = windows::Data::Pdf::PdfDocument::LoadFromFileAsync(&file)
        .map_err(|e| windows_error("无法打开 PDF", e))?
        .get()
        .map_err(|e| windows_error("无法读取 PDF", e))?;
    document
        .PageCount()
        .map_err(|e| windows_error("无法读取 PDF 页数", e))
}

#[cfg(not(windows))]
pub fn pdf_page_count(_path: &Path) -> Result<u32, String> {
    Err("PDF 页面预览当前仅支持 Windows".into())
}

#[cfg(not(windows))]
pub fn recognize_image(_path: &Path) -> Result<String, String> {
    Err("OCR 当前仅支持 Windows".to_string())
}

#[cfg(not(windows))]
pub fn recognize_pdf_page(_path: &Path, _page_number: u32) -> Result<String, String> {
    Err("OCR 当前仅支持 Windows".to_string())
}

#[cfg(not(windows))]
pub fn render_pdf_page_png(
    _path: &Path,
    _page_number: u32,
    _maximum_dimension: u32,
) -> Result<Vec<u8>, String> {
    Err("PDF 页面预览当前仅支持 Windows".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;
    #[cfg(windows)]
    #[test]
    fn native_subprocess_worker_entry() {
        worker::run_test_entry();
    }

    #[cfg(windows)]
    #[test]
    fn winrt_storage_path_converts_verbatim_drive_and_unc_paths() {
        for (input, expected) in [
            (r"\\?\D:\图片\OCR 😀.png", r"D:\图片\OCR 😀.png"),
            (r"\\?\c:\blobs-v1\a9\hash", r"c:\blobs-v1\a9\hash"),
            (
                r"\\?\UNC\server\share\文档 😀.pdf",
                r"\\server\share\文档 😀.pdf",
            ),
            (r"\\?\UNC\server\share", r"\\server\share"),
        ] {
            let actual = winrt_storage_path(Path::new(input)).unwrap();
            assert_eq!(&*actual, expected.encode_utf16().collect::<Vec<_>>());
        }
    }

    #[cfg(windows)]
    #[test]
    fn winrt_storage_path_preserves_ordinary_unicode_and_relative_paths() {
        use std::ffi::OsString;
        use std::os::windows::ffi::OsStringExt;
        for input in [
            r"D:\图片\OCR 😀.png",
            r"\\server\share\文档 😀.pdf",
            r"relative\image.png",
            r"C:relative.pdf",
            r"..\image.png",
            "D:/images/file.png",
        ] {
            let actual = winrt_storage_path(Path::new(input)).unwrap();
            assert_eq!(&*actual, input.encode_utf16().collect::<Vec<_>>());
        }
        let wide = [68, 58, 92, 0xD800, 46, 112, 110, 103];
        let path = PathBuf::from(OsString::from_wide(&wide));
        assert_eq!(&*winrt_storage_path(&path).unwrap(), &wide);
    }

    #[cfg(windows)]
    #[test]
    fn winrt_storage_path_rejects_unsupported_or_non_absolute_namespaces() {
        for input in [
            r"\\?\GLOBALROOT\Device\HarddiskVolume1\image.png",
            r"\\?\Volume{12345678-1234-1234-1234-123456789012}\image.png",
            r"\\.\PhysicalDrive0",
            r"\??\D:\image.png",
            r"\\?\C:relative.png",
            r"\\?\C:",
            r"\\?\C:/image.png",
            r"\\?\UNC\server",
            r"\\?\UNC\\share\image.png",
            r"\\?\UNC\server\\image.png",
            "\\\\?\\",
        ] {
            assert!(
                winrt_storage_path(Path::new(input))
                    .unwrap_err()
                    .starts_with("OCR_PATH_UNSUPPORTED:"),
                "accepted {input:?}"
            );
        }
    }

    #[cfg(windows)]
    #[test]
    fn winrt_storage_path_does_not_redirect_verbatim_special_components() {
        for input in [
            r"\\?\D:\folder.\image.png",
            "\\\\?\\D:\\folder \\image.png",
            r"\\?\D:\ leading\image.png",
            r"\\?\D:\folder\..\image.png",
            r"\\?\D:\folder\.\image.png",
            r"\\?\D:\folder/image.png",
            r"\\?\D:\folder\\image.png",
            r"\\?\D:\NUL.png",
            r"\\?\D:\NUL .png",
            r"\\?\D:\con\image.png",
            r"\\?\D:\pRn.pdf",
            r"\\?\D:\AUX",
            r"\\?\D:\COM1.txt",
            r"\\?\D:\Lpt9",
            r"\\?\D:\COM¹.txt",
            r"\\?\D:\LPT²\image.png",
            r"\\?\D:\CONIN$",
            r"\\?\D:\CONOUT$",
            r"\\?\UNC\server\share\NUL.png",
            r"\\?\D:\image.png:alternate",
        ] {
            assert!(
                winrt_storage_path(Path::new(input)).is_err(),
                "redirected {input:?}"
            );
        }
        for input in [
            r"\\?\D:\CONSOLE\image.png",
            r"\\?\D:\LPT0.png",
            r"\\?\D:\.hidden\image.png",
            r"\\?\UNC\CON\NUL\image.png",
        ] {
            assert!(
                winrt_storage_path(Path::new(input)).is_ok(),
                "rejected {input:?}"
            );
        }
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn native_worker_reuses_image_engine_and_immutable_pdf_session() {
        use lopdf::content::{Content, Operation};
        use lopdf::{dictionary, Document, Object, Stream};
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../task-state/project-optimization-20261011/ocr-native-tests")
            .join(crate::random_url_safe(8));
        std::fs::create_dir_all(&root).unwrap();
        // Keep the same canonical Win32 namespace emitted by the real data-root
        // producer. Image/PDF reads must exercise the StorageFile boundary.
        let root = root.canonicalize().unwrap();
        assert!(root.is_absolute());
        assert!(root.as_os_str().to_string_lossy().starts_with(r"\\?\"));
        assert!(!root
            .components()
            .any(|part| matches!(part, std::path::Component::ParentDir)));
        assert!(!root.to_string_lossy().contains('/'));
        let path = root.join("synthetic.pdf");
        let mut document = Document::with_version("1.5");
        let pages_id = document.new_object_id();
        let font = document
            .add_object(dictionary! { "Type"=>"Font","Subtype"=>"Type1","BaseFont"=>"Helvetica" });
        let resources = document.add_object(dictionary! { "Font"=>dictionary! {"F1"=>font} });
        let pages: Vec<Object> = (0..2)
            .map(|index| {
                let content = Content {
                    operations: vec![
                        Operation::new("BT", vec![]),
                        Operation::new("Tf", vec!["F1".into(), 48.into()]),
                        Operation::new("Td", vec![60.into(), 500.into()]),
                        Operation::new(
                            "Tj",
                            vec![Object::string_literal(if index == 0 {
                                "Craft OCR One"
                            } else {
                                "Craft OCR Two"
                            })],
                        ),
                        Operation::new("ET", vec![]),
                    ],
                };
                let content =
                    document.add_object(Stream::new(dictionary! {}, content.encode().unwrap()));
                document
                    .add_object(dictionary! {"Type"=>"Page","Parent"=>pages_id,"Contents"=>content})
                    .into()
            })
            .collect();
        document.objects.insert(pages_id,Object::Dictionary(dictionary! {"Type"=>"Pages","Kids"=>pages,"Count"=>2,"Resources"=>resources,"MediaBox"=>vec![0.into(),0.into(),595.into(),842.into()]}));
        let catalog = document.add_object(dictionary! {"Type"=>"Catalog","Pages"=>pages_id});
        document.trailer.set("Root", catalog);
        document.save(&path).unwrap();
        let image = root.join("synthetic.png");
        std::fs::write(&image, render_pdf_page_png(&path, 1, 1200).unwrap()).unwrap();
        assert_eq!(image.canonicalize().unwrap(), image);
        let before = native::counters();
        for _ in 0..4 {
            assert!(recognize_image_async(&image)
                .await
                .unwrap()
                .to_lowercase()
                .contains("craft"));
        }
        let after = native::counters();
        assert!(
            after.0 - before.0 <= 2,
            "only two worker-owned OCR engines may be created for repeated inputs"
        );
        let store = crate::BlobStore::open(&root.join("blobs-v1")).unwrap();
        let blob = store.put(&std::fs::read(&path).unwrap()).unwrap();
        let path = store.path_for(&blob.hash).unwrap();
        assert_eq!(path.canonicalize().unwrap(), path);
        let before = native::counters();
        for page in [1, 2, 1, 2] {
            let text = recognize_pdf_blob_page(&path, &blob.hash, page)
                .await
                .unwrap()
                .to_lowercase();
            assert!(
                text.contains(if page == 1 { "one" } else { "two" }),
                "native output must remain tied to the requested page: {text}"
            );
        }
        let after = native::counters();
        assert_eq!(
            after.1 - before.1,
            1,
            "same immutable PDF must be loaded once on its native owner thread"
        );
        let before = native::counters();
        // An arbitrary caller path must never reuse the immutable-content cache.
        for _ in 0..2 {
            native::execute(native::Job::Pdf {
                path: path.clone(),
                hash: None,
                page: 1,
            })
            .await
            .unwrap();
        }
        assert_eq!(native::counters().1 - before.1, 2);
        assert!(recognize_pdf_blob_page(&path, &blob.hash, 3)
            .await
            .unwrap_err()
            .contains("超出范围"));
        let recovered = recognize_pdf_blob_page(&path, &blob.hash, 2)
            .await
            .unwrap()
            .to_lowercase();
        assert!(
            recovered.contains("two"),
            "a failed page must not poison or relabel the next result"
        );
    }

    #[test]
    fn live_windows_image_ocr_probe() {
        let Some(path) = std::env::var_os("CRAFT_SEARCH_OCR_IMAGE") else {
            return;
        };
        let text = recognize_image(&PathBuf::from(path)).expect("recognize OCR image");
        let expected =
            std::env::var("CRAFT_SEARCH_OCR_EXPECT").unwrap_or_else(|_| "Craft".to_string());
        let normalized_text = text
            .chars()
            .filter(|character| character.is_alphanumeric())
            .flat_map(char::to_lowercase)
            .collect::<String>();
        let normalized_expected = expected
            .chars()
            .filter(|character| character.is_alphanumeric())
            .flat_map(char::to_lowercase)
            .collect::<String>();
        assert!(
            normalized_text.contains(&normalized_expected),
            "OCR image did not contain expected marker; recognized={text:?}"
        );
    }

    #[test]
    fn live_windows_pdf_ocr_probe() {
        let Some(path) = std::env::var_os("CRAFT_SEARCH_OCR_PDF") else {
            return;
        };
        let text = recognize_pdf_page(&PathBuf::from(path), 1).expect("recognize OCR PDF");
        let expected =
            std::env::var("CRAFT_SEARCH_OCR_EXPECT").unwrap_or_else(|_| "Craft".to_string());
        assert!(
            text.to_lowercase().contains(&expected.to_lowercase()),
            "OCR PDF did not contain expected marker"
        );
    }
}
