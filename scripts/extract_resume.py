import pdfplumber

path = "/home/z/my-project/upload/24BCS80009_kartheek.pdf"

with pdfplumber.open(path) as pdf:
    print(f"Pages: {len(pdf.pages)}")
    print("=" * 60)
    for i, page in enumerate(pdf.pages):
        text = page.extract_text()
        print(f"--- Page {i+1} ---")
        print(text if text else "[no extractable text]")
        print()
