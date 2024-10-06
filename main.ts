import {
	App,
	Modal,
	Menu,
	Notice,
	PaneType,
	Plugin,
	PluginSettingTab,
	setIcon,
	Setting,
	TFile,
} from "obsidian";

const toFile = (file: File | TFile, status: FileStatus): File => {
	return {
		basename: file.basename,
		path: file.path,
		status: status,
	} as File;
};

type DeleteSnapshotResult = "deleted" | "cancelled";

type Brand<K, T> = K & { __brand: T };

type FileStatus = "to_review" | "reviewed";

type File = Brand<
	{
		basename: string;
		path: string;
		status: FileStatus;
	},
	"File"
>;

interface Snapshot {
	files: File[];
	createdAt: Date;
}

interface Settings {
	showRandomFileRibbon: boolean;
	showStatusBar: boolean;
}

interface VaultReviewSettings {
	snapshot?: Snapshot;
	settings: Settings;
}

const DEFAULT_SETTINGS: VaultReviewSettings = {
	settings: {
		showRandomFileRibbon: true,
		showStatusBar: true,
	},
};

export default class VaultReviewPlugin extends Plugin {
	settings: VaultReviewSettings;
	settingsTab: VaultReviewSettingTab | null = null;

	statusBar: StatusBar;
	randomFileRibbon: HTMLElement;

	async onload() {
		await this.loadSettings();

		// Ribbon
		this.randomFileRibbon = this.addRibbonIcon(
			"dice",
			"Open random not reviewed file",
			() => {
				this.openRandomFile();
			}
		);
		this.setRandomFileRibbonIsVisible(
			this.settings.settings.showRandomFileRibbon
		);

		// Status bar
		const statusBarItemEl = this.addStatusBarItem();
		this.statusBar = new StatusBar(statusBarItemEl, this);
		this.statusBar.setIsVisible(this.settings.settings.showStatusBar);

		// Commands
		this.addCommand({
			id: "open-random-file",
			name: "Open random not reviewed file",
			callback: () => {
				this.openRandomFile();
			},
		});
		this.addCommand({
			id: "complete-review",
			name: "Review file",
			checkCallback: (checking) => {
				if (checking) {
					return this.getToReviewFiles().some(
						(file) => file.path === this.app.workspace.getActiveFile()?.path
					);
				}

				this.completeReview();
			},
		});
		this.addCommand({
			id: "complete-review-and-open-next",
			name: "Review file and open next random file",
			checkCallback: (checking) => {
				if (checking) {
					return this.getToReviewFiles().some(
						(file) => file.path === this.app.workspace.getActiveFile()?.path
					);
				}

				this.completeReview({ openNext: true });
			},
		});
		this.addCommand({
			id: "unreview-file",
			name: "Unreview file",
			checkCallback: (checking) => {
				if (checking) {
					return (
						this.settings.snapshot?.files.find(
							(file) => file.path === this.app.workspace.getActiveFile()?.path
						)?.status === "reviewed"
					);
				}

				this.unreviewFile();
			},
		});

		// Settings
		this.addSettingTab(new VaultReviewSettingTab(this.app, this));
	}

	onunload() {}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());

		if (typeof this.settings.snapshot?.createdAt === "string") {
			this.settings.snapshot.createdAt = new Date(
				this.settings.snapshot.createdAt
			);
		}

		console.log(this.settings);
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}

	setRandomFileRibbonIsVisible(isVisible: boolean) {
		this.randomFileRibbon.style.display = isVisible ? "flex" : "none";
	}

	getToReviewFiles() {
		return (
			this.settings.snapshot?.files.filter(
				(file) => file.status === "to_review"
			) ?? []
		);
	}

	async openRandomFile() {
		const files = this.getToReviewFiles();
		if (!files.length) {
			return;
		}

		const randomFile = files[Math.floor(Math.random() * files.length)];
		this.focusFile(randomFile, false);
	}

	private readonly focusFile = async (
		file: File,
		newLeaf: boolean | PaneType
	) => {
		const targetFile = this.app.vault
			.getFiles()
			.find((f) => f.path === file.path);

		if (targetFile) {
			const leaf = this.app.workspace.getLeaf(newLeaf);
			leaf.openFile(targetFile);
		} else {
			new Notice("Cannot find a file with that name");
			if (this.settings.snapshot) {
				this.settings.snapshot.files = this.settings.snapshot.files.filter(
					(fp) => fp.path !== file.path
				);
				await this.saveSettings();
			}
		}
	};

	public readonly completeReview = async ({
		file,
		openNext = false,
	}: {
		file?: File;
		openNext?: boolean;
	} = {}) => {
		const activeFile = file ?? this.app.workspace.getActiveFile();
		if (!activeFile) {
			return;
		}

		const snapshotFile = this.settings.snapshot?.files.find(
			(f) => f.path === activeFile.path
		);

		if (!snapshotFile) {
			new Notice("File was added to snapshot and marked as reviewed");
			this.settings.snapshot?.files.push(toFile(activeFile, "reviewed"));
		} else {
			snapshotFile.status = "reviewed";
		}

		if (openNext) {
			this.openRandomFile();
		}

		this.statusBar.update();
		await this.saveSettings();
	};

	public readonly unreviewFile = async (file?: File) => {
		const activeFile = file ?? this.app.workspace.getActiveFile();
		if (!activeFile) {
			return;
		}

		const snapshotFile = this.settings.snapshot?.files.find(
			(f) => f.path === activeFile.path
		);

		if (!snapshotFile) {
			new Notice("File was added to snapshot and marked as not reviewed");
			this.settings.snapshot?.files.push(toFile(activeFile, "to_review"));
		} else {
			snapshotFile.status = "to_review";
		}

		this.statusBar.update();
		await this.saveSettings();
	};

	public readonly deleteSnapshot = async ({
		askForConfirmation = true,
	}: {
		askForConfirmation?: boolean;
	} = {}) => {
		let resolve: (value: DeleteSnapshotResult) => void;
		const completer = new Promise<DeleteSnapshotResult>(
			(r, _) => (resolve = r)
		);

		const onDelete = async () => {
			this.settings.snapshot = undefined;
			await this.saveSettings();
			this.statusBar.update();
			resolve("deleted");
		};

		const onCancel = async () => {
			resolve("cancelled");
		};

		if (askForConfirmation) {
			new ConfirmSnapshotDeleteModal(this.app, onDelete, onCancel).open();
		} else {
			onDelete();
		}

		return completer;
	};
}

class StatusBar {
	element: HTMLElement;
	plugin: VaultReviewPlugin;

	isReviewed = false;

	constructor(element: HTMLElement, plugin: VaultReviewPlugin) {
		this.element = element;
		this.plugin = plugin;

		setIcon(element.createSpan("status-bar-item-icon"), "dice");
		element.createSpan("status").setText("Not reviewed");
		element.addClass("mod-clickable");

		this.element.addEventListener("click", (e) => this.onClick(e));

		this.plugin.app.workspace.on("file-open", () => this.update());

		this.update();
	}

	onClick = (event: MouseEvent) => {
		const menu = new Menu();

		menu.addItem((item) => {
			item.setTitle("Reviewed");
			item.setChecked(this.isReviewed);
			item.onClick(() => this.plugin.completeReview());
		});

		menu.addItem((item) => {
			item.setTitle("Not reviewed");
			item.setChecked(!this.isReviewed);
			item.onClick(() => this.plugin.unreviewFile());
		});

		menu.showAtMouseEvent(event);
	};

	update = (file?: TFile | null) => {
		if (!this.plugin.settings.snapshot) {
			this.setIsVisible(false);
			return;
		}

		const activeFile = file ?? this.plugin.app.workspace.getActiveFile();
		if (!activeFile) {
			this.setIsVisible(false);
			return;
		}

		this.setIsVisible(true);

		const snapshotFile = this.plugin.settings.snapshot.files.find(
			(f) => f.path === activeFile.path
		);
		if (!snapshotFile) {
			this.setText("New file");
			return;
		}

		this.isReviewed = snapshotFile.status === "reviewed";
		if (this.isReviewed) {
			this.setText("Reviewed");
		} else {
			this.setText("Not reviewed");
		}
	};

	setText(text: string) {
		this.element.getElementsByClassName("status")[0].setText(text);
	}

	setIsVisible(isVisible: boolean) {
		this.element.style.display = isVisible ? "inline-flex" : "none";
	}
}

class VaultReviewSettingTab extends PluginSettingTab {
	plugin: VaultReviewPlugin;

	constructor(app: App, plugin: VaultReviewPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		this.plugin.settingsTab = this;

		const snapshotDate = this.plugin.settings.snapshot?.createdAt;

		// Main action
		const settingEl = new Setting(containerEl)
			.setName("Snapshot")
			.setDesc(
				snapshotDate
					? `Snapshot created on ${snapshotDate.toLocaleDateString()}.`
					: "Create a snapshot of the vault."
			);
		if (snapshotDate) {
			settingEl.addButton((btn) => {
				btn.setIcon("trash");
				btn.setWarning();
				btn.onClick(async () => {
					await this.plugin.deleteSnapshot();
					this.display();
				});
			});
			settingEl.addButton((btn) => {
				btn.setButtonText("Add all new files to snapshot").onClick(async () => {
					const vaultFiles = this.plugin.app.vault
						.getMarkdownFiles()
						.filter(
							(file) =>
								!this.plugin.settings.snapshot?.files.some(
									(f) => f.path === file.path
								)
						)
						.map((file) => toFile(file, "to_review"));
					this.plugin.settings.snapshot?.files.push(...vaultFiles);

					await this.plugin.saveSettings();
					this.plugin.statusBar.update();
					this.display();
				});

				return btn;
			});
		} else {
			settingEl.addButton((btn) => {
				btn.setButtonText("Create snapshot");
				btn.setCta();
				btn.onClick(async () => {
					const files = this.plugin.app.vault
						.getMarkdownFiles()
						.map((file) => toFile(file, "to_review"));
					this.plugin.settings.snapshot = {
						files,
						createdAt: new Date(),
					};

					await this.plugin.saveSettings();
					this.plugin.statusBar.update();
					this.display();
				});
			});
		}

		// Snapshot info
		if (snapshotDate) {
			containerEl.createDiv("snapshot-info", (div) => {
				const allFilesLength = this.plugin.app.vault.getMarkdownFiles().length;
				const snapshotFilesLength =
					this.plugin.settings.snapshot?.files.length ?? 0;
				const notInSnapshotLength = allFilesLength - snapshotFilesLength;
				const reviewedFilesLength =
					this.plugin.settings.snapshot?.files.filter(
						(file) => file.status === "reviewed"
					).length ?? 0;
				const toReviewFilesLength = snapshotFilesLength - reviewedFilesLength;

				const percentSnapshotCompleted = Math.round(
					(reviewedFilesLength / snapshotFilesLength) * 100
				);

				div.createEl("p").setText(`Markdown files in vault: ${allFilesLength}`);

				const inSnapshotEl = div.createDiv("in-snapshot");
				inSnapshotEl
					.createSpan()
					.setText(`In snapshot: ${snapshotFilesLength}`);
				inSnapshotEl.createSpan().setText(`To review: ${toReviewFilesLength}`);
				inSnapshotEl
					.createSpan()
					.setText(
						`Reviewed: ${reviewedFilesLength} (${percentSnapshotCompleted}%)`
					);
				div.createEl("p").setText(`Not in snapshot: ${notInSnapshotLength}`);
			});
		}

		new Setting(containerEl)
			.setName("Status bar")
			.setDesc("Show file review status in the status bar.")
			.addToggle((toggle) => {
				toggle.setValue(this.plugin.settings.settings.showStatusBar);
				toggle.onChange(async (value) => {
					this.plugin.settings.settings.showStatusBar = value;
					this.plugin.statusBar.setIsVisible(value);
					await this.plugin.saveSettings();
				});
			});

		new Setting(containerEl)
			.setName("Random file ribbon")
			.setDesc("Show ribbon that opens random not reviewed file.")
			.addToggle((toggle) => {
				toggle.setValue(this.plugin.settings.settings.showStatusBar);
				toggle.onChange(async (value) => {
					this.plugin.settings.settings.showRandomFileRibbon = value;
					this.plugin.setRandomFileRibbonIsVisible(value);
					await this.plugin.saveSettings();
				});
			});
	}
}

export class ConfirmSnapshotDeleteModal extends Modal {
	constructor(
		app: App,
		onDelete: () => Promise<void> | void,
		onCancel: () => Promise<void> | void
	) {
		super(app);

		this.setTitle("Delete snapshot?");

		new Setting(this.contentEl)
			.setName("This action cannot be undone")
			.setDesc(
				"You will lose all progress and will need to create a new snapshot."
			)
			.addButton((btn) => {
				btn.setButtonText("Cancel");
				btn.onClick(async () => {
					await onCancel();
					this.close();
				});
			})
			.addButton((btn) => {
				btn.setButtonText("Delete");
				btn.setWarning();
				btn.onClick(async () => {
					await onDelete();
					this.close();
				});
			});
	}
}
