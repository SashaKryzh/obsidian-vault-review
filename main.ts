import {
	App,
	Menu,
	Modal,
	Notice,
	PaneType,
	Plugin,
	PluginSettingTab,
	Setting,
	SuggestModal,
	TAbstractFile,
	TFile,
	TFolder,
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

type AllFileStatus = FileStatus | "new";

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
	showStatusBar: boolean;
}

interface VaultReviewSettings {
	snapshot?: Snapshot;
	settings: Settings;
}

const DEFAULT_SETTINGS: VaultReviewSettings = {
	settings: {
		showStatusBar: true,
	},
};

export default class VaultReviewPlugin extends Plugin {
	settings: VaultReviewSettings;
	settingsTab: VaultReviewSettingTab | null = null;

	statusBar: StatusBar;
	fileStatusControllerRibbon: HTMLElement;

	async onload() {
		await this.loadSettings();

		this.fileStatusControllerRibbon = this.addRibbonIcon(
			"scan-eye",
			"Open vault review",
			() => {
				this.openFileStatusController();
			}
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

		// Events
		this.app.vault.on("rename", this.handleFileRename);
		this.app.vault.on("delete", this.handleFileDelete);
	}

	onunload() {}

	getActiveFile() {
		return this.app.workspace.getActiveFile();
	}

	getActiveFileStatus(): AllFileStatus | undefined {
		const activeFile = this.getActiveFile();
		if (!activeFile) {
			return;
		}

		const snapshotFile = this.settings.snapshot?.files.find(
			(f) => f.path === activeFile.path
		);

		return snapshotFile?.status ?? "new";
	}

	private readonly handleFileRename = async (
		file: TAbstractFile,
		oldPath: string
	) => {
		if (file instanceof TFolder) {
			return;
		}

		const snapshotFile = this.settings.snapshot?.files.find(
			(f) => f.path === oldPath
		);

		if (snapshotFile) {
			snapshotFile.path = file.path;
			await this.saveSettings();
		}
	};

	private readonly handleFileDelete = async (file: TAbstractFile) => {
		if (file instanceof TFolder || !this.settings.snapshot) {
			return;
		}

		this.settings.snapshot.files = this.settings.snapshot.files.filter(
			(f) => f.path !== file.path
		);
		await this.saveSettings();
	};

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

	getToReviewFiles() {
		return (
			this.settings.snapshot?.files.filter(
				(file) => file.status === "to_review"
			) ?? []
		);
	}

	async openFileStatusController() {
		if (!this.settings.snapshot) {
			new Notice("Vault review snapshot is not created");
			return;
		}

		new FileStatusControllerModal(this.app, this).open();
	}

	async openRandomFile() {
		if (!this.settings.snapshot) {
			new Notice("Vault review snapshot is not created");
			return;
		}

		const files = this.getToReviewFiles();
		if (!files.length) {
			new Notice("All files are reviewed");
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

		// setIcon(element.createSpan("status-bar-item-icon"), "scan-eye");
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
		if (!this.plugin.settings.snapshot) {
			this.element.style.display = "none";
		} else {
			this.element.style.display = isVisible ? "inline-flex" : "none";
		}
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

const ACTIONS = {
	open_random: {
		name: "Open random not reviewed file",
	},
	review: {
		name: "Review file",
	},
	review_and_next: {
		name: "Review file and open next random file",
	},
	unreview: {
		name: "Unreview file",
	},
} as const;

type Action = keyof typeof ACTIONS;

class FileStatusControllerModal extends SuggestModal<Action> {
	plugin: VaultReviewPlugin;

	constructor(app: App, plugin: VaultReviewPlugin) {
		super(app);
		this.plugin = plugin;

		const fileStatus = this.plugin.getActiveFileStatus();
		this.setPlaceholder(
			!fileStatus
				? ""
				: fileStatus === "new"
				? "This file is not in snapshot"
				: fileStatus === "to_review"
				? "This file is not reviewed"
				: "This file is reviewed"
		);
	}

	getSuggestions(query: string): Action[] {
		const activeFile = this.plugin.getActiveFile();
		let actions: Action[] = [];

		if (!activeFile) {
			actions = ["open_random"];
		} else {
			const isReviewed =
				this.plugin.settings.snapshot?.files.find(
					(f) => f.path === activeFile.path
				)?.status === "reviewed";

			if (isReviewed) {
				actions = ["open_random", "unreview"];
			} else {
				actions = ["review_and_next", "review", "open_random"];
			}
		}

		return actions.filter((a) =>
			ACTIONS[a].name.toLowerCase().includes(query.toLowerCase())
		);
	}

	renderSuggestion(action: Action, el: HTMLElement) {
		el.createEl("div", { text: ACTIONS[action].name });
	}

	onChooseSuggestion(action: Action, evt: MouseEvent | KeyboardEvent) {
		if (action === "open_random") {
			this.plugin.openRandomFile();
		}

		if (action === "review") {
			this.plugin.completeReview();
		}

		if (action === "review_and_next") {
			this.plugin.completeReview({ openNext: true });
		}

		if (action === "unreview") {
			this.plugin.unreviewFile();
		}
	}
}
