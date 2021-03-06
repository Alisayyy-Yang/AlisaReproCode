// Copyright (c) Microsoft Corporation. All rights reserved. Licensed under the MIT license.
// See LICENSE in the project root for license information.

import * as colors from 'colors';
import { EOL } from 'os';
import {
  CommandLineFlagParameter,
  CommandLineStringParameter
} from '@microsoft/ts-command-line';

import {
  IChangeInfo,
  ChangeType
} from '../../data/ChangeManagement';
import RushConfigurationProject from '../../data/RushConfigurationProject';
import Npm from '../../utilities/Npm';
import RushCommandLineParser from './RushCommandLineParser';
import PublishUtilities from '../utilities/PublishUtilities';
import ChangelogGenerator from '../utilities/ChangelogGenerator';
import GitPolicy from '../utilities/GitPolicy';
import PrereleaseToken from '../utilities/PrereleaseToken';
import ChangeManager from '../utilities/ChangeManager';
import { BaseRushAction } from './BaseRushAction';
import { Git } from '../utilities/Git';

export default class PublishAction extends BaseRushAction {
  private _addCommitDetails: CommandLineFlagParameter;
  private _apply: CommandLineFlagParameter;
  private _includeAll: CommandLineFlagParameter;
  private _npmAuthToken: CommandLineStringParameter;
  private _npmTag: CommandLineStringParameter;
  private _parser: RushCommandLineParser;
  private _publish: CommandLineFlagParameter;
  private _regenerateChangelogs: CommandLineFlagParameter;
  private _registryUrl: CommandLineStringParameter;
  private _targetBranch: CommandLineStringParameter;
  private _prereleaseName: CommandLineStringParameter;
  private _suffix: CommandLineStringParameter;
  private _force: CommandLineFlagParameter;
  private _prereleaseToken: PrereleaseToken;
  private _versionPolicy: CommandLineStringParameter;

  constructor(parser: RushCommandLineParser) {
    super({
      actionVerb: 'publish',
      summary: 'Reads and processes package publishing change requests generated by "rush change".',
      documentation:
      'Reads and processes package publishing change requests generated by "rush change". This will perform a ' +
      'read-only operation by default, printing operations executed to the console. To commit ' +
      'changes and publish packages, you must use the --commit flag and/or the --publish flag.'
    });
    this._parser = parser;
  }

  protected onDefineParameters(): void {
    this._apply = this.defineFlagParameter({
      parameterLongName: '--apply',
      parameterShortName: '-a',
      description: 'If this flag is specified, the change requests will be applied to package.json files.'
    });
    this._targetBranch = this.defineStringParameter({
      parameterLongName: '--target-branch',
      parameterShortName: '-b',
      key: 'BRANCH',
      description:
      'If this flag is specified, applied changes and deleted change requests will be' +
      'committed and merged into the target branch.'
    });
    this._publish = this.defineFlagParameter({
      parameterLongName: '--publish',
      parameterShortName: '-p',
      description: 'If this flag is specified, applied changes will be published to npm.'
    });
    this._addCommitDetails = this.defineFlagParameter({
      parameterLongName: '--add-commit-details',
      parameterShortName: undefined,
      description: 'Adds commit author and hash to the changelog.json files for each change.'
    });
    this._regenerateChangelogs = this.defineFlagParameter({
      parameterLongName: '--regenerate-changelogs',
      parameterShortName: undefined,
      description: 'Regenerates all changelog files based on the current JSON content.'
    });
    this._registryUrl = this.defineStringParameter({
      parameterLongName: '--registry',
      parameterShortName: '-r',
      key: 'REGISTRY',
      description:
      `Publishes to a specified NPM registry. If this is specified, it will prevent the current commit will not be ` +
      'tagged.'
    });
    this._npmAuthToken = this.defineStringParameter({
      parameterLongName: '--npm-auth-token',
      parameterShortName: '-n',
      key: 'TOKEN',
      description:
      'Provide the default scope npm auth token to be passed into npm publish for global package publishing.'
    });
    this._npmTag = this.defineStringParameter({
      parameterLongName: '--tag',
      parameterShortName: '-t',
      key: 'TAG',
      description:
      `The tag option to pass to npm publish. By default npm will publish using the 'latest' tag, even if ` +
      `the package is older than the current latest, so in publishing workflows for older releases, providing ` +
      `a tag is important.`
    });
    this._includeAll = this.defineFlagParameter({
      parameterLongName: '--include-all',
      parameterShortName: undefined,
      description: 'If this flag is specified, all packages with shouldPublish=true in rush.json ' +
      'or with a specified version policy ' +
      'will be published if their version is newer than published version.'
    });
    this._versionPolicy = this.defineStringParameter({
      parameterLongName: '--version-policy',
      parameterShortName: '-vp',
      key: 'VERSIONPOLICY',
      description: 'Version policy name. Only projects with this version policy will be published if used ' +
      'with --include-all.'
    });
    this._prereleaseName = this.defineStringParameter({
      parameterLongName: '--prerelease-name',
      parameterShortName: '-pn',
      key: 'NAME',
      description: 'Bump up to a prerelease version with the provided prerelease name. Cannot be used with --suffix'
    });
    this._suffix = this.defineStringParameter({
      parameterLongName: '--suffix',
      key: 'SUFFIX',
      description: 'Append a suffix to all changed versions. Cannot be used with --prerelease-name.'
    });
    this._force = this.defineFlagParameter({
      parameterLongName: '--force',
      parameterShortName: undefined,
      description: 'If this flag is specified with --publish, packages will be published with --force on npm'
    });
  }

  /**
   * Executes the publish action, which will read change request files, apply changes to package.jsons,
   */
  protected run(): void {
    if (!GitPolicy.check(this.rushConfiguration)) {
      process.exit(1);
      return;
    }
    const allPackages: Map<string, RushConfigurationProject> = this.rushConfiguration.projectsByName;

    if (this._regenerateChangelogs.value) {
      console.log('Regenerating changelogs');
      ChangelogGenerator.regenerateChangelogs(allPackages);
      return;
    }

    if (this._includeAll.value) {
      this._publishAll(allPackages);
    } else {
      this._prereleaseToken = new PrereleaseToken(this._prereleaseName.value, this._suffix.value);
      this._publishChanges(allPackages);
    }

    console.log(EOL + colors.green('Rush publish finished successfully.'));
  }

  private _publishChanges(allPackages: Map<string, RushConfigurationProject>): void {
    const changeManager: ChangeManager = new ChangeManager(this.rushConfiguration);
    changeManager.load(this.rushConfiguration.changesFolder,
      this._prereleaseToken,
      this._addCommitDetails.value);

    if (changeManager.hasChanges()) {
      const orderedChanges: IChangeInfo[] = changeManager.changes;
      const git: Git = new Git(this._targetBranch.value);
      const tempBranch: string = 'publish-' + new Date().getTime();

      // Make changes in temp branch.
      git.checkout(tempBranch, true);

      // Make changes to package.json and change logs.
      changeManager.apply(this._apply.value);
      changeManager.updateChangelog(this._apply.value);

      // Stage, commit, and push the changes to remote temp branch.
      git.addChanges();
      git.commit();
      git.push(tempBranch);

      // NPM publish the things that need publishing.
      for (const change of orderedChanges) {
        if (change.changeType && change.changeType > ChangeType.dependency) {
          const project: RushConfigurationProject | undefined = allPackages.get(change.packageName);
          if (project) {
            this._npmPublish(change.packageName, project.projectFolder);
          }
        }
      }

      // Create and push appropriate git tags.
      this._gitAddTags(git, orderedChanges);
      git.push(tempBranch);

      // Now merge to target branch.
      git.checkout(this._targetBranch.value);
      git.pull();
      git.merge(tempBranch);
      git.push(this._targetBranch.value);
      git.deleteBranch(tempBranch);
    }
  }

  private _publishAll(allPackages: Map<string, RushConfigurationProject>): void {
    console.log(`Rush publish starts with includeAll and version policy ${this._versionPolicy.value}`);

    let updated: boolean = false;
    const git: Git = new Git(this._targetBranch.value);

    allPackages.forEach((packageConfig, packageName) => {
      if (packageConfig.shouldPublish &&
        (!this._versionPolicy.value || this._versionPolicy.value === packageConfig.versionPolicyName)
      ) {
        if (this._force.value || !this._packageExists(packageConfig)) {
          this._npmPublish(packageName, packageConfig.projectFolder);
          git.addTag(!!this._publish.value && !this._registryUrl.value, packageName, packageConfig.packageJson.version);
          updated = true;
        } else {
          console.log(`Skip ${packageName}. Not updated.`);
        }
      }
    });
    if (updated) {
      git.push(this._targetBranch.value);
    }
  }

  private _gitAddTags(git: Git, orderedChanges: IChangeInfo[]): void {
    for (const change of orderedChanges) {
      if (
        change.changeType &&
        change.changeType > ChangeType.dependency &&
        this.rushConfiguration.projectsByName.get(change.packageName)!.shouldPublish
      ) {
        git.addTag(!!this._publish.value && !this._registryUrl.value, change.packageName, change.newVersion!);
      }
    }
  }

  private _npmPublish(packageName: string, packagePath: string): void {
    const env: { [key: string]: string } = PublishUtilities.getEnvArgs();
    const args: string[] = ['publish'];

    if (this.rushConfiguration.projectsByName.get(packageName)!.shouldPublish) {
      let registry: string = '//registry.npmjs.org/';
      if (this._registryUrl.value) {
        const registryUrl: string = this._registryUrl.value;
        env['npm_config_registry'] = registryUrl; // tslint:disable-line:no-string-literal
        registry = registryUrl.substring(registryUrl.indexOf('//'));
      }

      if (this._npmAuthToken.value) {
        args.push(`--${registry}:_authToken=${this._npmAuthToken.value}`);
      }

      if (this._npmTag.value) {
        args.push(`--tag`, this._npmTag.value);
      }

      if (this._force.value) {
        args.push(`--force`);
      }

      PublishUtilities.execCommand(
        !!this._publish.value,
        this.rushConfiguration.npmToolFilename,
        args,
        packagePath,
        env);
    }
  }

  private _packageExists(packageConfig: RushConfigurationProject): boolean {
    const env: { [key: string]: string } = PublishUtilities.getEnvArgs();
    if (this._registryUrl.value) {
      env['npm_config_registry'] = this._registryUrl.value; // tslint:disable-line:no-string-literal
    }
    const publishedVersions: string[] = Npm.publishedVersions(packageConfig.packageName,
      packageConfig.projectFolder,
      env);
    return publishedVersions.indexOf(packageConfig.packageJson.version) >= 0;
  }
}