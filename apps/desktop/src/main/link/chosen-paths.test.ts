import { describe, expect, it } from 'vitest';
import { createDefaultIntegrationProfile } from '../../renderer/src/link/view-models/local-integration-profile';
import { ChosenPaths, requireChosenPrograms } from './chosen-paths';

describe('ChosenPaths', () => {
  it('只接受本次运行中操作员选择过的路径', () => {
    const chosen = new ChosenPaths('这个文件不是通过联动台选择或拖入的');
    expect(() => chosen.require('/music/song.wav')).toThrow('这个文件不是通过联动台选择或拖入的，已拒绝：/music/song.wav');
    chosen.choose('/music/song.wav');
    chosen.require('/music/song.wav');
    expect(chosen.has('/music/other.wav')).toBe(false);
  });
});

describe('requireChosenPrograms', () => {
  it('集成档案只能写入操作员选择、一键识别找到、原档案已有或默认安装位置的程序', () => {
    const chosen = new ChosenPaths('这个程序位置不是通过联动台选择或一键识别得到的');
    const folders = new ChosenPaths('这个启动文件夹不是通过联动台选择的');
    const profile = createDefaultIntegrationProfile();
    requireChosenPrograms(profile, null, chosen, folders);
    const planted = { ...profile, obs: { ...profile.obs, executablePath: 'C:\\Users\\Public\\伪造.exe', workingDirectory: 'C:\\Users\\Public' } };
    expect(() => requireChosenPrograms(planted, null, chosen, folders)).toThrow('这个程序位置不是通过联动台选择或一键识别得到的，已拒绝：C:\\Users\\Public\\伪造.exe');
    expect(() => requireChosenPrograms({ ...profile, ma2: { ...profile.p1, connectOnDemand: true, executablePath: 'D:\\tools\\onpc.exe', workingDirectory: 'D:\\tools' } }, null, chosen, folders)).toThrow('一键识别得到');
    requireChosenPrograms(planted, planted, chosen, folders);
    chosen.choose('C:\\Users\\Public\\伪造.exe');
    requireChosenPrograms(planted, null, chosen, folders);
  });

  it('启动文件夹只能是程序所在文件夹、原档案已有或通过对话框选择的文件夹', () => {
    const chosen = new ChosenPaths('这个程序位置不是通过联动台选择或一键识别得到的');
    const folders = new ChosenPaths('这个启动文件夹不是通过联动台选择的');
    const profile = createDefaultIntegrationProfile();
    const planted = { ...profile, obs: { ...profile.obs, workingDirectory: 'C:\\Users\\Public\\带 DLL 的文件夹' } };
    expect(() => requireChosenPrograms(planted, null, chosen, folders)).toThrow('这个启动文件夹不是通过联动台选择的，已拒绝：C:\\Users\\Public\\带 DLL 的文件夹');
    requireChosenPrograms(planted, planted, chosen, folders);
    folders.choose('C:\\Users\\Public\\带 DLL 的文件夹');
    requireChosenPrograms(planted, null, chosen, folders);
    chosen.choose('D:\\OBS\\bin\\64bit\\obs64.exe');
    requireChosenPrograms({ ...profile, obs: { ...profile.obs, executablePath: 'D:\\OBS\\bin\\64bit\\obs64.exe', workingDirectory: 'D:\\OBS\\bin\\64bit' } }, null, chosen, folders);
  });

  it('启动参数只接受白名单：OBS 只能用不启动输出的开关，其他程序不接受参数', () => {
    const chosen = new ChosenPaths('这个程序位置不是通过联动台选择或一键识别得到的');
    const folders = new ChosenPaths('这个启动文件夹不是通过联动台选择的');
    const profile = createDefaultIntegrationProfile();
    const obs = (args: string[]) => ({ ...profile, obs: { ...profile.obs, arguments: args } });
    requireChosenPrograms(obs(['--portable', '--multi', '--disable-updater', '--disable-missing-files-check', '--profile', '直播', '--collection', '团播 A']), null, chosen, folders);
    for (const args of [['--startstreaming'], ['--startrecording'], ['--startvirtualcam'], ['--profile'], ['--profile', '--startstreaming'], ['--scene', '"; calc'], ['/c', 'calc.exe']]) {
      expect(() => requireChosenPrograms(obs(args), null, chosen, folders), args.join(' ')).toThrow('OBS 启动参数不在允许范围内');
    }
    expect(() => requireChosenPrograms({ ...profile, p1: { ...profile.p1, arguments: ['--anything'] } }, null, chosen, folders)).toThrow('P1 不接受启动参数');
    expect(() => requireChosenPrograms(obs(['--startstreaming']), obs(['--startstreaming']), chosen, folders)).toThrow('OBS 启动参数不在允许范围内');
  });
});
