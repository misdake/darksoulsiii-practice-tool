export class RegionConfirmDialog {
  constructor(byId) {
    this.byId = byId;
  }

  async confirm(message) {
    const dialog = this.byId("confirmDialog");
    if (!dialog?.showModal) return false;

    this.byId("confirmMessage").textContent = message;
    return new Promise((resolve) => {
      const controller = new AbortController();
      const options = { signal: controller.signal };
      const finish = (accepted) => {
        controller.abort();
        dialog.close();
        resolve(accepted);
      };

      this.byId("confirmOkBtn").addEventListener(
        "click",
        () => finish(true),
        options,
      );
      this.byId("confirmCancelBtn").addEventListener(
        "click",
        () => finish(false),
        options,
      );
      dialog.addEventListener("cancel", () => finish(false), options);
      dialog.showModal();
    });
  }
}
