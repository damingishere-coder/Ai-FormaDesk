"""Read only the current inference process group's macOS memory counters."""
import ctypes
import sys


class UsageV4(ctypes.Structure):
    # SDK sys/resource.h, rusage_info_v4. Keep layout identical to the ABI.
    _fields_ = [('uuid', ctypes.c_uint8 * 16)] + [(name, ctypes.c_uint64) for name in (
        'user_time system_time pkg_idle_wkups interrupt_wkups pageins wired_size '
        'resident_size phys_footprint proc_start_abstime proc_exit_abstime '
        'child_user_time child_system_time child_pkg_idle_wkups child_interrupt_wkups '
        'child_pageins child_elapsed_abstime diskio_bytesread diskio_byteswritten '
        'cpu_time_qos_default cpu_time_qos_maintenance cpu_time_qos_background '
        'cpu_time_qos_utility cpu_time_qos_legacy cpu_time_qos_user_initiated '
        'cpu_time_qos_user_interactive billed_system_time serviced_system_time '
        'logical_writes lifetime_max_phys_footprint instructions cycles '
        'billed_energy serviced_energy interval_max_phys_footprint runnable_time').split()]


class MemorySampler:
    def __init__(self):
        self.samples = 0
        self.group_peak = 0
        self.process_peak = 0
        self.unavailable = None
        self.lib = None
        if sys.platform == 'darwin':
            try:
                self.lib = ctypes.CDLL('/usr/lib/libproc.dylib', use_errno=True)
                self.lib.proc_listpgrppids.argtypes = [ctypes.c_int, ctypes.c_void_p, ctypes.c_int]
                self.lib.proc_pid_rusage.argtypes = [ctypes.c_int, ctypes.c_int, ctypes.POINTER(UsageV4)]
            except OSError as error:
                self.unavailable = str(error)

    def sample(self, group):
        if self.lib is None:
            return
        pids = (ctypes.c_int * 256)()
        count = self.lib.proc_listpgrppids(group, pids, ctypes.sizeof(pids))
        if count <= 0:
            return
        if count >= len(pids):
            self.unavailable = 'Process group exceeds memory sampler capacity'
            return
        total = 0
        measured = 0
        for pid in pids[:count]:
            usage = UsageV4()
            if self.lib.proc_pid_rusage(pid, 4, ctypes.byref(usage)) == 0:
                total += usage.phys_footprint
                self.process_peak = max(self.process_peak, usage.lifetime_max_phys_footprint)
                measured += 1
        if measured:
            self.samples += 1
            self.group_peak = max(self.group_peak, total)

    def report(self):
        return {'method': 'macOS proc_pid_rusage v4, private process group, sampled every second',
                'samples': self.samples,
                'sampledPeakGroupFootprintBytes': self.group_peak if self.samples else None,
                'largestProcessLifetimePeakBytes': self.process_peak if self.samples else None,
                'unavailable': self.unavailable,
                'limitation': 'Process footprint counters, not a separate GPU meter or exact whole-machine peak.'}
