# CETG Transport & Expense Claim Form

A staff claim form that runs entirely in the browser, on each person's own device.

- Add receipt screenshots or photos; the amount and date are read on the device (Tesseract OCR), nothing is uploaded.
- Key in the trip details, check each amount, and the month is totalled automatically.
- Sign on screen; the signed claim is a PDF (with the receipts inside) that is emailed to the reporting officer.
- The reporting officer opens the PDF in the same form under **Approver**, checks each item beside its receipt, and signs the approved PDF back.
- After the first visit the form is kept on the device and works without internet. It can be installed as an app.
- Claims stay in the browser and, on a computer, in a folder the person chooses. A lost month can be brought back from the PDF that was sent.

This repository holds the static site only. There is no server and no database: nothing in it is anyone's claim data.

Third-party components are listed in `vendor/LICENSES.txt`.
